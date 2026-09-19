import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertCommandArgs, assertPathAllowed, assertRealPathInside } from '../tools/tool-policy';
import { classifyCodex, classifySessionProbe, describeCliFailure, parseCliJson } from '../providers/cli-status';
import { iconForStatus } from '../ui/status-icon';
import { splitNdjson } from '../providers/ndjson';
import { toGeminiPayload } from '../providers/gemini-format';
import { ModelPermissionManager } from '../security/model-permissions';
import { TaskStore } from '../orchestrator/task-store';

const read = (path: string) => readFile(join(process.cwd(), path), 'utf8');

test('tool policy blocks secrets, protected write targets and traversal', () => {
  for (const path of ['.env', '.env.local', 'app/.env', '.git/config', '.ssh/id_rsa', 'certs/server.pem', 'src/../.env']) {
    assert.throws(() => assertPathAllowed(path, 'read'), /blocks read/, path);
  }
  for (const path of ['.vscode/settings.json', '.git/hooks/pre-commit', '.env', 'src/../.vscode/tasks.json']) {
    assert.throws(() => assertPathAllowed(path, 'write'), /blocks write/, path);
  }
  assert.doesNotThrow(() => assertPathAllowed('src/index.ts', 'write'));
  assert.doesNotThrow(() => assertPathAllowed('.env.example', 'read'));
  assert.doesNotThrow(() => assertPathAllowed('.vscode/settings.json', 'read'));
});

test('tool policy constrains allowlisted commands that would otherwise run arbitrary code', () => {
  for (const [command, args] of [
    ['node', ['-e', 'process.exit()']], ['node', ['--eval=1']], ['node', ['-r', 'x']], ['node', []],
    ['git', ['-c', 'core.sshCommand=evil', 'fetch']], ['git', ['push']], ['git', ['diff', '--output=/tmp/x']], ['git', []],
    ['npm', ['exec', 'evil']], ['npm', ['run', 'x', '--script-shell=/bin/sh']], ['npm', ['--prefix', '/']],
    ['npx', ['evil-package']], ['curl', ['http://x']],
  ] as Array<[string, string[]]>) {
    assert.throws(() => assertCommandArgs(command, args), Error, `${command} ${args.join(' ')}`);
  }
  for (const [command, args] of [
    ['node', ['scripts/build.js', '--flag']], ['git', ['log', '--oneline']], ['git', ['status']], ['npm', ['test']], ['npm', ['run', 'lint']],
  ] as Array<[string, string[]]>) {
    assert.doesNotThrow(() => assertCommandArgs(command, args), `${command} ${args.join(' ')}`);
  }
});

test('real-path check rejects a link that leaves the workspace but allows new files inside it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'orchestra-'));
  const root = join(base, 'ws');
  const outside = join(base, 'outside');
  try {
    await mkdir(root); await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await assertRealPathInside(root, join(root, 'new', 'file.ts'));
    await assert.rejects(assertRealPathInside(root, join(base, 'elsewhere.txt')), /outside the active workspace/);
    try { await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch { return; /* symlink creation not permitted on this machine */ }
    await assert.rejects(assertRealPathInside(root, join(root, 'link', 'secret.txt')), /outside the active workspace/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('Codex status never treats "Not logged in" or API-key billing as a subscription session', () => {
  assert.equal(classifyCodex('Not logged in').authenticated, false);
  assert.equal(classifyCodex('Logged in using ChatGPT').authenticated, true);
  assert.equal(classifyCodex('Logged in using ChatGPT').accountType, 'ChatGPT');
  const apiKey = classifyCodex('Logged in using an API key');
  assert.equal(apiKey.authenticated, false);
  assert.match(apiKey.error ?? '', /billed per token/);
});

test('Grok and Antigravity are only "authenticated" when the probe actually confirms a session', () => {
  assert.equal(classifySessionProbe('', 'xAI account', 'Grok').authenticated, false);
  assert.equal(classifySessionProbe('   \n', 'xAI account', 'Grok').authenticated, false);
  assert.equal(classifySessionProbe('Error: please log in first', 'xAI account', 'Grok').authenticated, false);
  assert.equal(classifySessionProbe('{"error":"authentication required"}', 'Google', 'Antigravity').authenticated, false);
  const ok = classifySessionProbe('grok-build\ngrok-4', 'xAI account', 'Grok');
  assert.equal(ok.authenticated, true);
  assert.equal(ok.accountType, 'xAI account');
});

test('CLI failures never echo the prompt that was passed as an argument', () => {
  const prompt = 'SYSTEM:\nTOP-SECRET workspace file contents';
  const failure = Object.assign(new Error(`Command failed: codex exec --json ${prompt}\nboom`), { code: 1, stderr: 'line1\nauth failed' });
  const message = describeCliFailure('Codex', failure);
  assert.doesNotMatch(message, /TOP-SECRET/);
  assert.match(message, /auth failed/);
  assert.match(describeCliFailure('Codex', Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' })), /timed out/);
  assert.match(describeCliFailure('Codex', Object.assign(new Error('x'), { name: 'AbortError' })), /cancelled/);
  assert.throws(() => parseCliJson('Grok', 'not json TOP-SECRET'), (error: Error) => !/TOP-SECRET/.test(error.message));
  assert.deepEqual(parseCliJson('Grok', 'warning: x\n{"text":"hi"}'), { text: 'hi' });
});

test('provider status icons do not show a green check for negative states', () => {
  assert.equal(iconForStatus('Not authenticated · codex 1.0'), 'x');
  assert.equal(iconForStatus('Not installed'), 'x');
  assert.equal(iconForStatus('Not configured'), 'x');
  assert.equal(iconForStatus('Not Running'), 'debug-disconnect');
  assert.equal(iconForStatus('Previously authenticated · checking…'), 'sync');
  assert.equal(iconForStatus('Available · 1.0 · ChatGPT'), 'check');
  assert.equal(iconForStatus('Signed in: someone'), 'check');
  assert.equal(iconForStatus('Rate limited'), 'warning');
});

test('NDJSON splitting keeps a JSON object that spans two network chunks intact', () => {
  const first = splitNdjson('', '{"message":{"content":"he');
  assert.deepEqual(first.lines, []);
  const second = splitNdjson(first.rest, 'llo"}}\n{"done":true}\n');
  assert.deepEqual(second.lines.map(line => JSON.parse(line)), [{ message: { content: 'hello' } }, { done: true }]);
  assert.equal(second.rest, '');
});

test('Gemini payload puts system text in systemInstruction and keeps turns alternating', () => {
  const payload = toGeminiPayload([
    { role: 'system', content: 'be brief' }, { role: 'user', content: 'a' }, { role: 'user', content: 'b' },
    { role: 'assistant', content: 'c' }, { role: 'user', content: 'd' },
  ]);
  assert.equal(payload.system, 'be brief');
  assert.deepEqual(payload.history.map(turn => turn.role), ['user', 'model']);
  assert.equal(payload.history[0].parts[0].text, 'a\n\nb');
  assert.equal(payload.last, 'd');
  assert.throws(() => toGeminiPayload([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]), /end with a user message/);
});

test('an unrecognised agent id does not inherit supervisor model grants in restricted mode', () => {
  const state = { mode: 'restricted', assignments: { supervisor: ['openai:*'], coder: ['ollama:llama'] } };
  const memento = { get: () => state, update: async () => undefined };
  const permissions = new ModelPermissionManager(memento as never, {} as never);
  assert.equal(permissions.isAllowed('supervisor', 'openai', 'gpt-4o'), true);
  assert.equal(permissions.isAllowed('coder-1', 'ollama', 'llama'), true);
  assert.equal(permissions.isAllowed('coder-1', 'openai', 'gpt-4o'), false);
  assert.equal(permissions.isAllowed('rogue-agent', 'openai', 'gpt-4o'), false);
  assert.equal(permissions.isAllowed('', 'openai', 'gpt-4o'), false);
});

const fakeMemento = (failFirstWrites = 0) => {
  const data = new Map<string, unknown>();
  let failures = failFirstWrites;
  return {
    data,
    get: <T>(key: string, fallback: T) => (data.has(key) ? data.get(key) as T : fallback),
    update: async (key: string, value: unknown) => { if (failures-- > 0) throw new Error('disk full'); data.set(key, value); },
  };
};
const sampleTask = (id: string, status: string) => ({
  id, goalId: 'g1', description: id, acceptanceCriteria: [], dependencies: [], status, backupAgentIds: [],
  tokenBudget: 1000, reservedTokens: 1000, usedTokens: 0, handoffThreshold: 0.2, attempt: 0, artifacts: [], createdAt: 1, updatedAt: 1,
});

test('a failed Memento write does not poison later task-store writes', async () => {
  const memento = fakeMemento(1);
  const store = new TaskStore(memento as never);
  await assert.rejects(store.putTask(sampleTask('t1', 'queued') as never), /disk full/);
  await store.putTask(sampleTask('t2', 'queued') as never);
  const saved = memento.data.get('ai-orchestra.orchestration.v1') as { tasks: Array<{ id: string }> };
  assert.deepEqual(saved.tasks.map(task => task.id).sort(), ['t1', 't2']);
});

test('tasks left running by a previous session are failed instead of silently resumed', async () => {
  const memento = fakeMemento();
  memento.data.set('ai-orchestra.orchestration.v1', {
    goals: [{ id: 'g1', objective: 'x', taskIds: ['a', 'b', 'c'], status: 'active', createdAt: 1, updatedAt: 1 }],
    tasks: [sampleTask('a', 'running'), sampleTask('b', 'completed'), sampleTask('c', 'leased')],
  });
  const store = new TaskStore(memento as never);
  assert.equal(await store.failInterrupted(), 2);
  assert.equal(store.getTask('a')?.status, 'failed');
  assert.equal(store.getTask('c')?.status, 'failed');
  assert.equal(store.getTask('b')?.status, 'completed');
  assert.equal(store.getGoal('g1')?.status, 'failed');
  assert.equal(store.getTasks().filter(task => ['queued', 'leased', 'running', 'handoff'].includes(task.status)).length, 0, 'nothing is left in flight to be resumed');
});

test('security-sensitive settings are machine-scoped and the extension declares workspace trust', async () => {
  const manifest = JSON.parse(await read('package.json'));
  const props = manifest.contributes.configuration.properties;
  for (const key of ['billing.mode', 'tools.allowTerminal', 'tools.allowWorkspaceWrite', 'ollama.endpoint']) {
    assert.equal(props[`ai-orchestra.${key}`].scope, 'machine', `${key} must not be overridable by a workspace's .vscode/settings.json`);
  }
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
  assert.ok(props['ai-orchestra.budget.maxTokensPerDay'], 'daily token limit needs its own setting');
  assert.ok(props['ai-orchestra.budget.criticalThreshold']);
  assert.match(await read('src/budget/budget-manager.ts'), /get<number>\('maxTokensPerDay'/);
  assert.doesNotMatch(await read('src/tools/tool-runtime.ts'), /'npx'/);
});

// BudgetManager needs `vscode` at import time; give it a minimal stand-in.
function loadBudgetManager(settings: Record<string, number>) {
  const fakeVscode = {
    workspace: {
      getConfiguration: () => ({ get: (key: string, fallback: unknown) => settings[key] ?? fallback }),
      onDidChangeConfiguration: () => ({ dispose() { /* noop */ } }),
    },
    EventEmitter: class { public event = () => ({ dispose() { /* noop */ } }); public fire(): void { /* noop */ } public dispose(): void { /* noop */ } },
  };
  const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
  const original = loader._load;
  loader._load = function (request: string, ...rest: unknown[]) { return request === 'vscode' ? fakeVscode : original.call(this, request, ...rest); };
  try {
    const { BudgetManager } = require('../budget/budget-manager');
    const { CostCalculator } = require('../budget/cost-calculator');
    const { TokenEstimator } = require('../budget/token-estimator');
    return { BudgetManager, CostCalculator, TokenEstimator };
  } finally { loader._load = original; }
}
const summary = (totalTokens: number, totalCost: number) => ({ totalTokens, totalCost, totalRequests: 0, byProvider: {}, byModel: {} });

test('free providers are not blocked by an exhausted dollar cap, paid ones are', () => {
  const { BudgetManager, CostCalculator, TokenEstimator } = loadBudgetManager({ maxCostPerDay: 5 });
  const tracker = { getDailySummary: () => summary(10, 9.5), getSessionSummary: () => summary(10, 9.5), resetSession() { /* noop */ } };
  const budget = new BudgetManager(tracker, new CostCalculator(), new TokenEstimator());
  assert.equal(budget.canAfford('llama3', 100, 'ollama').allowed, true);
  assert.equal(budget.reserveRequest('llama3', 100, 100, 'ollama').allowed, true);
  assert.equal(budget.canAfford('gpt-4o', 100, 'openai').allowed, false);
  assert.equal(budget.reserveRequest('gpt-4o', 100, 100, 'openai').allowed, false);
});

test('the daily token limit is independent of the session limit', () => {
  const { BudgetManager, CostCalculator, TokenEstimator } = loadBudgetManager({ maxTokensPerSession: 1000, maxTokensPerDay: 500000 });
  const tracker = { getDailySummary: () => summary(5000, 0), getSessionSummary: () => summary(0, 0), resetSession() { /* noop */ } };
  const budget = new BudgetManager(tracker, new CostCalculator(), new TokenEstimator());
  assert.equal(budget.canAfford('llama3', 100, 'ollama').allowed, true, 'daily usage above the session limit must not block a fresh session');
  assert.equal(budget.getBudgetStatus().tokenBudget.limit, 500000);
});
