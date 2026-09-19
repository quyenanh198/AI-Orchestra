import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationContext } from '../context/conversation-context';
import { AgentCandidate, rankAgents } from '../orchestrator/agent-ranking';
import { DelegationEvent, DelegationSupervisor } from '../orchestrator/delegation-supervisor';
import { LimitTracker, isRateLimitMessage, parseRetryDelayMs } from '../orchestrator/limit-tracker';
import { TaskStore } from '../orchestrator/task-store';
import { describeLimit } from '../ui/agent-view';
import type { AIProvider, Message } from '../providers/types';

const fakeMemento = () => {
  const data = new Map<string, unknown>();
  return { data, get: <T>(key: string, fallback: T) => (data.has(key) ? data.get(key) as T : fallback), update: async (key: string, value: unknown) => { data.set(key, value); } };
};
const available = (providerId: string, remaining = Number.POSITIVE_INFINITY, cap?: number) =>
  ({ providerId, used: 0, cap, remaining, available: true });
const candidate = (providerId: string, tier: AgentCandidate['tier'], order = 0, status = available(providerId)): AgentCandidate =>
  ({ providerId, name: providerId, tier, order, status });

test('the supervisor picks the agent whose tier fits and keeps premium quota for premium work', () => {
  const agents = [candidate('claude-code', 'premium', 1), candidate('ollama', 'budget', 5), candidate('vscode-lm', 'standard', 0)];
  assert.equal(rankAgents(agents, 'budget').ranked[0].providerId, 'ollama');
  assert.equal(rankAgents(agents, 'standard').ranked[0].providerId, 'vscode-lm');
  assert.equal(rankAgents(agents, 'premium').ranked[0].providerId, 'claude-code');
});

test('an agent with no remaining limit is never chosen, and the reason is reported', () => {
  const exhausted = { ...available('codex-cli', 0, 10), available: false, reason: 'configured limit of 10 request(s) per 5 h is used up' };
  const { ranked, rejected } = rankAgents([candidate('codex-cli', 'premium', 0, exhausted), candidate('claude-code', 'premium', 1)], 'premium');
  assert.deepEqual(ranked.map(agent => agent.providerId), ['claude-code']);
  assert.match(rejected[0].reason, /used up/);
});

test('more remaining headroom wins between equally suitable agents; a pinned agent overrides fit but not availability', () => {
  const busy = candidate('a', 'premium', 0, available('a', 2, 40));
  const fresh = candidate('b', 'premium', 1, available('b', 38, 40));
  assert.equal(rankAgents([busy, fresh], 'premium').ranked[0].providerId, 'b');
  assert.deepEqual(rankAgents([busy, fresh], 'premium', 'a').ranked.map(agent => agent.providerId), ['a']);
  const down = { ...available('a', 0, 40), available: false, reason: 'rate-limited' };
  assert.equal(rankAgents([candidate('a', 'premium', 0, down), fresh], 'premium', 'a').ranked.length, 0);
});

test('limit tracker counts requests per window, expires them, and pauses an agent that reports a rate limit', async () => {
  let now = 1_000_000;
  const memento = fakeMemento();
  const tracker = new LimitTracker(memento as never, () => ({ 'claude-code': { requests: 2, windowHours: 1 } }), () => now);
  assert.equal(tracker.status('claude-code').remaining, 2);
  assert.equal(tracker.status('codex-cli').remaining, Number.POSITIVE_INFINITY, 'no rule means unlimited');
  await tracker.record('claude-code');
  await tracker.record('claude-code');
  const used = tracker.status('claude-code');
  assert.equal(used.available, false);
  assert.match(used.reason ?? '', /used up/);
  now += 61 * 60_000;
  assert.equal(tracker.status('claude-code').available, true, 'requests older than the window no longer count');

  const until = await tracker.recordRateLimit('codex-cli', 'Usage limit reached. Try again in 2 hours.');
  assert.equal(until - now, 2 * 3_600_000);
  assert.equal(tracker.status('codex-cli').available, false);
  const reloaded = new LimitTracker(memento as never, () => ({}), () => now);
  assert.equal(reloaded.status('codex-cli').available, false, 'the cooldown survives a restart');
});

test('rate-limit messages and retry hints are understood', () => {
  assert.equal(isRateLimitMessage('Error 429: too many requests'), true);
  assert.equal(isRateLimitMessage('You have reached your usage limit'), true);
  assert.equal(isRateLimitMessage('syntax error near x'), false);
  assert.equal(parseRetryDelayMs('retry after 30 seconds'), 30_000);
  assert.equal(parseRetryDelayMs('try again in 5 minutes'), 300_000);
  assert.equal(parseRetryDelayMs('limit reached'), 15 * 60_000);
});

const contextOptions = (over: Partial<{ recentTurns: number }> = {}) => ({
  recentTurns: 2, digestLineChars: 40, maxDigestLines: 5, maxNotes: 3, estimate: (text: string) => Math.ceil(text.length / 4), ...over,
});

test('shared context folds old turns into a digest instead of keeping or re-sending them in full', async () => {
  const context = new ConversationContext(fakeMemento() as never, contextOptions());
  for (let index = 1; index <= 4; index += 1) {
    await context.append({ role: 'user', content: `question ${index} ${'x'.repeat(200)}` });
    await context.append({ role: 'assistant', content: `answer ${index}`, agentId: 'claude-code' });
  }
  assert.equal(context.turns.length, 2);
  assert.equal(context.digest.length, 5, 'digest is capped');
  assert.ok(context.digest.every(line => line.length <= 60), 'digest lines are one short line each');
  const packed = context.pack('next question', 1000);
  assert.equal(packed[0].role, 'system');
  assert.match(packed[0].content, /Earlier conversation/);
  assert.equal(packed.at(-1)?.content, 'next question');
  assert.doesNotMatch(packed[0].content, /x{100}/, 'long old content is only present as a short digest line');
  assert.equal(packed.filter(message => message.content.includes('question 1')).length, 0, 'the oldest turn is not resent verbatim');
});

test('packing respects the budget but always keeps the new prompt, and notes are remembered', async () => {
  const context = new ConversationContext(fakeMemento() as never, contextOptions({ recentTurns: 10 }));
  await context.append({ role: 'user', content: 'a'.repeat(400) });
  await context.append({ role: 'assistant', content: 'b'.repeat(400), agentId: 'codex-cli' });
  await context.addNote('read src/a.ts (120 chars)');
  await context.addNote('read src/a.ts (120 chars)');
  assert.equal(context.notes.length, 1, 'duplicate notes are ignored');
  const tight = context.pack('hi', 4);
  assert.deepEqual(tight.map(message => message.content), ['hi']);
  const roomy = context.pack('hi', 1000);
  assert.match(roomy[0].content, /read src\/a\.ts/);
  assert.equal(roomy.length, 4);
});

test('context survives a restart and Clear forgets everything', async () => {
  const memento = fakeMemento();
  const first = new ConversationContext(memento as never, contextOptions());
  await first.append({ role: 'user', content: 'remember this' });
  await first.addNote('wrote src/b.ts');
  const second = new ConversationContext(memento as never, contextOptions());
  assert.equal(second.turns[0].content, 'remember this');
  assert.deepEqual([...second.notes], ['wrote src/b.ts']);
  await second.clear();
  assert.equal(new ConversationContext(memento as never, contextOptions()).turns.length, 0);
});

const model = (providerId: string, tier: 'budget' | 'standard' | 'premium') => ({
  id: `${providerId}-m`, name: providerId, provider: providerId, maxContextTokens: 100_000, inputPricePerMToken: 0, outputPricePerMToken: 0, tier,
});
const provider = (id: string, tier: 'budget' | 'standard' | 'premium', isUp = true): AIProvider => ({
  id, name: id, models: [model(id, tier)], isAvailable: async () => isUp,
  getRateLimitStatus: () => ({ requestsRemaining: 0, requestsLimit: 0, tokensRemaining: 0, tokensLimit: 0, resetAt: null, isLimited: false }),
  chat: async () => { throw new Error('not used'); }, stream: async function* () { /* unused */ }, configure: () => undefined, dispose: () => undefined,
});
const reply = (content: string, providerId: string) => ({
  response: { content, model: `${providerId}-m`, provider: providerId, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 } },
  routingDecision: { provider: providerId, model: `${providerId}-m`, reason: '', wasFallback: false }, taskAnalysis: {}, budgetStatus: {},
});

interface Call { provider?: string; strict?: boolean; agentId?: string; messages: Message[] }
function build(options: {
  providers: AIProvider[];
  script: (call: Call) => string | Error;
  creditAllowed?: boolean;
  tools?: (call: { tool: string; path?: string }) => string;
  rules?: Record<string, { requests?: number; windowHours?: number }>;
  permitted?: (providerId: string) => boolean;
}) {
  const calls: Call[] = [];
  const events: DelegationEvent[] = [];
  const memento = fakeMemento();
  const limits = new LimitTracker(memento as never, () => options.rules ?? {});
  const context = new ConversationContext(fakeMemento() as never, { recentTurns: 8, digestLineChars: 120, maxDigestLines: 30, maxNotes: 20, estimate: text => Math.ceil(text.length / 4) });
  const store = new TaskStore(fakeMemento() as never);
  const supervisor = new DelegationSupervisor({
    orchestrator: {
      execute: async (messages, opts) => {
        const call = { provider: opts.preferredProvider, strict: opts.strictProvider, agentId: opts.agentId, messages: JSON.parse(JSON.stringify(messages)) as Message[] };
        calls.push(call);
        const outcome = options.script(call);
        if (outcome instanceof Error) throw outcome;
        return reply(outcome, opts.preferredProvider as string) as never;
      },
    },
    providers: () => options.providers,
    isCredit: id => ['openai', 'anthropic', 'gemini'].includes(id),
    creditAllowed: () => options.creditAllowed ?? false,
    isPermitted: (_agent, providerId) => options.permitted?.(providerId) ?? true,
    fallbackOrder: () => options.providers.map(item => item.id),
    limits, context, store,
    tools: { executeCall: async (_agent, call) => (options.tools ?? (() => 'FILE BODY'))(call) },
    analyze: () => ({ type: 'explanation', complexity: 'medium', estimatedInputTokens: 10, estimatedOutputTokens: 10, recommendedTier: 'standard', keywords: [], context: '' }),
    settings: () => ({ maxToolTurns: 4, contextTokens: 8000, maxTaskTokens: 8000 }),
    emit: event => events.push(event),
  });
  return { supervisor, calls, events, limits, context, store };
}

test('exactly one agent executes a prompt, chosen by the supervisor, and the executor is strictly bound to it', async () => {
  const { supervisor, calls, store } = build({
    providers: [provider('claude-code', 'premium'), provider('vscode-lm', 'standard'), provider('ollama', 'budget')],
    script: () => 'done',
  });
  const outcome = await supervisor.handle('explain the build');
  assert.equal(calls.length, 1, 'one model call, one agent');
  assert.equal(calls[0].provider, 'vscode-lm', 'a standard task goes to the standard-tier agent, sparing premium quota');
  assert.equal(calls[0].strict, true);
  assert.equal(outcome.decision.agentId, 'vscode-lm');
  assert.equal(outcome.attempts, 1);
  assert.match(outcome.decision.reason, /standard tier matches/);
  assert.equal(store.getTasks().length, 1);
  assert.equal(store.getTasks()[0].status, 'completed');
  assert.equal(store.getTasks()[0].primaryAgentId, 'vscode-lm');
});

test('credit providers are never candidates in subscription/free mode, even when they are signed in', async () => {
  const providers = [provider('openai', 'standard'), provider('ollama', 'budget')];
  const free = build({ providers, script: () => 'ok' });
  await free.supervisor.handle('hello');
  assert.equal(free.calls[0].provider, 'ollama');
  assert.deepEqual((await free.supervisor.listAgents()).map(agent => agent.providerId), ['ollama']);

  const paid = build({ providers, script: () => 'ok', creditAllowed: true });
  assert.deepEqual((await paid.supervisor.listAgents()).map(agent => agent.providerId).sort(), ['ollama', 'openai']);
});

test('when the chosen agent hits its rate limit the next agent takes over and the first is paused', async () => {
  const { supervisor, calls, limits, events } = build({
    providers: [provider('vscode-lm', 'standard'), provider('claude-code', 'premium')],
    script: call => call.provider === 'vscode-lm' ? new Error('Usage limit reached. Try again in 1 hour.') : 'answer from claude',
  });
  const outcome = await supervisor.handle('explain');
  assert.deepEqual(calls.map(call => call.provider), ['vscode-lm', 'claude-code'], 'sequential fallback, never parallel');
  assert.equal(outcome.decision.agentId, 'claude-code');
  assert.equal(outcome.attempts, 2);
  assert.equal(limits.status('vscode-lm').available, false);
  assert.deepEqual(events.map(event => event.state), ['delegated', 'redelegated', 'completed']);
  const next = await supervisor.handle('again');
  assert.equal(calls.at(-1)?.provider, 'claude-code', 'the paused agent is skipped on the next prompt');
  assert.equal(next.attempts, 1);
});

test('a configured limit that is used up excludes that agent until the window passes', async () => {
  const { supervisor, calls } = build({
    providers: [provider('vscode-lm', 'standard'), provider('claude-code', 'premium')],
    script: () => 'ok',
    rules: { 'vscode-lm': { requests: 1, windowHours: 5 } },
  });
  await supervisor.handle('first');
  await supervisor.handle('second');
  assert.deepEqual(calls.map(call => call.provider), ['vscode-lm', 'claude-code']);
});

test('later agents get the shared context instead of re-reading, including notes from earlier tool use', async () => {
  let turn = 0;
  const { supervisor, calls, context } = build({
    providers: [provider('vscode-lm', 'standard'), provider('claude-code', 'premium')],
    script: call => {
      turn += 1;
      if (turn === 1) return '<tool_call>{"tool":"read_file","path":"src/app.ts"}</tool_call>';
      if (turn === 2) return 'The app starts in src/app.ts.';
      return `follow-up with ${call.messages.length} messages`;
    },
    tools: () => 'export const app = 1;',
  });
  const first = await supervisor.handle('where does the app start?');
  assert.equal(first.result.response.content, 'The app starts in src/app.ts.', 'tool_call blocks are not shown to the user');
  assert.equal(calls.length, 2, 'one tool turn then the final answer, by the same agent');
  assert.ok(calls.every(call => call.provider === 'vscode-lm'));
  assert.deepEqual([...context.notes], ['read src/app.ts (21 chars)']);

  await supervisor.handle('and what does it export?');
  const third = JSON.stringify(calls[2].messages);
  assert.match(third, /where does the app start/, 'the earlier question is in the shared context');
  assert.match(third, /The app starts in src\/app\.ts\./, 'the earlier answer is in the shared context');
  assert.match(third, /read src\/app\.ts/, 'files already inspected are listed as workspace notes');
  assert.equal(calls[2].agentId, 'coder-1');
});

test('a failed or cancelled request does not pollute the shared context, and cancellation never falls through to another agent', async () => {
  const controller = new AbortController();
  const { supervisor, calls, context, store } = build({
    providers: [provider('vscode-lm', 'standard'), provider('claude-code', 'premium')],
    script: () => { controller.abort(); return new Error('aborted'); },
  });
  await assert.rejects(supervisor.handle('do it', { signal: controller.signal }), /aborted/);
  assert.equal(calls.length, 1, 'no second agent after the user pressed Stop');
  assert.equal(context.turns.length, 0);
  assert.equal(store.getTasks()[0].status, 'failed');
  assert.equal(store.getGoal(store.getTasks()[0].goalId)?.status, 'failed');
});

test('an agent that is not permitted for the executor role is not a candidate, and having no candidate is a clear error', async () => {
  const restricted = build({ providers: [provider('vscode-lm', 'standard')], script: () => 'ok', permitted: () => false });
  await assert.rejects(restricted.supervisor.handle('x'), /No subscription\/free agent .*not permitted/);
  const signedOut = build({ providers: [provider('claude-code', 'premium', false)], script: () => 'ok' });
  await assert.rejects(signedOut.supervisor.handle('x'), /not signed in or not running/);
  const pinned = build({ providers: [provider('vscode-lm', 'standard'), provider('claude-code', 'premium', false)], script: () => 'ok' });
  pinned.supervisor.setPinned('claude-code');
  await assert.rejects(pinned.supervisor.handle('x'), /pinned agent claude-code is not available/);
  pinned.supervisor.setPinned(undefined);
  assert.equal((await pinned.supervisor.handle('x')).decision.agentId, 'vscode-lm');
});

test('limit text tells the user what is left', () => {
  assert.equal(describeLimit(available('a')), 'no limit configured');
  assert.equal(describeLimit(available('a', 7, 40)), '7/40 requests left');
  assert.match(describeLimit({ ...available('a', 0, 40), used: 40 }), /limit used up \(40\/40\)/);
  assert.match(describeLimit({ ...available('a'), cooldownUntil: Date.now() + 1000 }), /rate limited/);
});

test('the manifest exposes the delegation settings and drops the multi-agent ones', async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
  const props = manifest.contributes.configuration.properties;
  for (const key of ['limits', 'context.maxTokens', 'context.recentTurns', 'agents.maxToolTurns']) assert.ok(props[`ai-orchestra.${key}`], key);
  assert.equal(props['ai-orchestra.limits'].scope, 'machine');
  assert.equal(props['ai-orchestra.billing.mode'].default, 'subscriptionOnly');
  for (const key of ['agents.maxConcurrent', 'agents.leaseSeconds', 'budget.handoffThreshold']) assert.equal(props[`ai-orchestra.${key}`], undefined, `${key} no longer applies`);
});
