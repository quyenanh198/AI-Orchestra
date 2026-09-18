import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const read = (path: string) => readFile(join(process.cwd(), path), 'utf8');

test('budget manager reads the exact settings contributed by the manifest', async () => {
  const manifest = JSON.parse(await read('package.json'));
  const source = await read('src/budget/budget-manager.ts');
  const properties = manifest.contributes.configuration.properties;
  assert.ok(properties['ai-orchestra.budget.maxTokensPerSession']);
  assert.ok(properties['ai-orchestra.budget.maxCostPerDay']);
  assert.match(source, /getConfiguration\('ai-orchestra\.budget'\)/);
  assert.match(source, /get<number>\('maxTokensPerSession'/);
  assert.match(source, /get<number>\('maxCostPerDay'/);
});

test('supervisor persists leases, checkpoints, backups, and handoff state', async () => {
  const types = await read('src/agents/types.ts');
  const store = await read('src/orchestrator/task-store.ts');
  const supervisor = await read('src/orchestrator/multi-agent-supervisor.ts');
  for (const field of ['backupAgentIds', 'leaseExpiresAt', 'heartbeatAt', 'checkpoint', 'handoffThreshold']) assert.match(types, new RegExp(field));
  assert.match(store, /leaseTask/);
  assert.match(store, /getExpiredLeases/);
  assert.match(supervisor, /recoverExpiredLeases/);
  assert.match(supervisor, /state: 'handoff'/);
});

test('agents receive provider invocation and tool capabilities without raw API keys', async () => {
  const broker = await read('src/security/credential-broker.ts');
  const tools = await read('src/tools/tool-runtime.ts');
  assert.doesNotMatch(broker, /SecretStorage|apiKey/);
  assert.match(tools, /workspace\.write/);
  assert.match(tools, /allowWorkspaceWrite/);
  assert.match(tools, /terminal\.execute/);
  assert.match(tools, /ALLOWED_COMMANDS/);
});

test('runtime provider failures trigger another routing decision', async () => {
  const orchestrator = await read('src/orchestrator/orchestrator.ts');
  assert.match(orchestrator, /excluded\.add\(routingDecision\.provider\)/);
  assert.match(orchestrator, /Runtime fallback/);
  assert.match(orchestrator, /All providers failed/);
});

test('account login keeps refresh credentials in SecretStorage', async () => {
  const google = await read('src/security/google-oauth.ts');
  const vscodeProvider = await read('src/providers/vscode-lm-provider.ts');
  assert.match(google, /SecretStorage/);
  assert.match(google, /refreshToken/);
  assert.match(google, /expectedState/);
  assert.doesNotMatch(google, /writeFile|globalState\.update/);
  assert.match(vscodeProvider, /authentication\.getSession\('github'/);
  assert.match(vscodeProvider, /lm\.selectChatModels/);
});

test('restricted mode enforces per-role model assignments at invocation time', async () => {
  const permissions = await read('src/security/model-permissions.ts');
  const broker = await read('src/security/credential-broker.ts');
  assert.match(permissions, /mode === 'open'/);
  assert.match(permissions, /assignments\[role\]/);
  assert.match(permissions, /providerId.*modelId/);
  assert.match(broker, /permissions\.isAllowed/);
  assert.match(broker, /Model permission denied/);
});
