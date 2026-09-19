import * as crypto from 'node:crypto';
import type { AgentDefinition, TaskRecord } from '../agents/types';
import type { ConversationContext } from '../context/conversation-context';
import type { AIProvider, Message } from '../providers/types';
import type { OrchestratorResult } from './orchestrator';
import type { TaskAnalysis } from './task-analyzer';
import type { TaskStore } from './task-store';
import { AgentCandidate, Tier, rankAgents } from './agent-ranking';
import { LimitStatus, LimitTracker, isRateLimitMessage } from './limit-tracker';

export interface ToolCall { tool: string; path?: string; content?: string; command?: string; args?: string[] }

export interface DelegationEvent {
  state: 'delegated' | 'redelegated' | 'completed' | 'failed';
  goalId: string;
  agentId?: string;
  detail?: string;
}

export interface DelegationDecision {
  agentId: string;
  agentName: string;
  reason: string;
  limit: LimitStatus;
  /** Agents that were considered and skipped, with why. */
  skipped: Array<{ providerId: string; reason: string }>;
}

export interface DelegationResult { result: OrchestratorResult; decision: DelegationDecision; attempts: number }

export interface DelegationDeps {
  orchestrator: {
    execute(messages: Message[], options: {
      signal?: AbortSignal; preferredProvider?: string; strictProvider?: boolean; maxTokens?: number; agentId?: string;
    }): Promise<OrchestratorResult>;
  };
  providers: () => AIProvider[];
  isCredit: (providerId: string) => boolean;
  /** True only in "credit with confirmation" billing mode. */
  creditAllowed: () => boolean;
  isPermitted: (agentId: string, providerId: string, modelId: string) => boolean;
  fallbackOrder: () => string[];
  limits: LimitTracker;
  context: ConversationContext;
  store: TaskStore;
  tools: { executeCall(agent: AgentDefinition, call: ToolCall): Promise<string> };
  analyze: (messages: Message[]) => TaskAnalysis;
  settings: () => { maxToolTurns: number; contextTokens: number; maxTaskTokens: number };
  emit: (event: DelegationEvent) => void;
}

/** The single worker identity. Model permissions in Restricted mode are assigned to its `coder` role. */
export const EXECUTOR: AgentDefinition = {
  id: 'coder-1', role: 'coder', providerPreference: 'auto', backupFor: [],
  capabilities: ['workspace.read', 'workspace.write', 'terminal.execute', 'provider.invoke'],
};

const TOOL_BLOCK = /<tool_call>([\s\S]*?)<\/tool_call>/;
const EXECUTOR_PROMPT = [
  'You are the executor agent the supervisor selected for this request; no other agent will work on it.',
  'The supervisor already supplied shared context (an earlier-conversation digest and workspace notes). Use it instead of',
  're-reading files or asking the user to repeat themselves; only re-read a file when you need its exact current content.',
  'Answer the request directly. Never claim tools or edits you did not perform.',
  'Tool protocol: emit exactly <tool_call>{"tool":"read_file|write_file|execute",...}</tool_call>. Tools are gated by user',
  'settings and may be refused; report a refusal instead of working around it.',
].join(' ');

const TIER_RANK: Record<Tier, number> = { budget: 0, standard: 1, premium: 2 };

/**
 * The main agent. It never calls a model itself: it inspects the prompt, ranks the available subscription/free agents by
 * fit and remaining headroom, and hands the prompt to exactly one of them together with the shared context. Another agent
 * is tried only if the chosen one fails (for example when it reports a rate limit).
 */
export class DelegationSupervisor {
  private pinned?: string;

  constructor(private readonly deps: DelegationDeps) {}

  public getPinned(): string | undefined { return this.pinned; }
  public setPinned(providerId: string | undefined): void { this.pinned = providerId; }

  /** Agents this supervisor may delegate to right now, with their remaining headroom. */
  public async listAgents(): Promise<Array<{ providerId: string; name: string; tier: Tier; status: LimitStatus }>> {
    return (await this.candidates()).candidates.map(({ providerId, name, tier, status }) => ({ providerId, name, tier, status }));
  }

  public async handle(prompt: string, options: { signal?: AbortSignal; pinned?: string } = {}): Promise<DelegationResult> {
    const pinned = options.pinned ?? this.pinned;
    const analysis = this.deps.analyze([{ role: 'user', content: prompt }]);
    const { candidates, unavailable } = await this.candidates();
    const { ranked, rejected } = rankAgents(candidates, analysis.recommendedTier, pinned);
    const skipped = [...unavailable, ...rejected];
    if (!ranked.length) {
      const why = skipped.map(item => `${item.providerId}: ${item.reason}`).join('; ') || 'no agent is configured';
      throw new Error(pinned && !candidates.some(c => c.providerId === pinned)
        ? `The pinned agent ${pinned} is not available (${why}). Choose Auto or log in to it.`
        : `No subscription/free agent can take this request right now (${why}).`);
    }

    const goalId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const now = Date.now();
    const { maxToolTurns, maxTaskTokens } = this.deps.settings();
    await this.deps.store.putGoal({ id: goalId, objective: prompt.slice(0, 500), taskIds: [taskId], status: 'active', createdAt: now, updatedAt: now });
    await this.deps.store.putTask(this.taskRecord(taskId, goalId, prompt, ranked[0].providerId, ranked.slice(1).map(r => r.providerId), maxTaskTokens, now));

    const failures: string[] = [];
    for (const [attempt, agent] of ranked.entries()) {
      this.deps.emit({ state: attempt === 0 ? 'delegated' : 'redelegated', goalId, agentId: agent.providerId, detail: agent.reason });
      await this.deps.store.updateStatus(taskId, 'running', { primaryAgentId: agent.providerId, attempt: attempt + 1 });
      try {
        const result = await this.execute(agent.providerId, prompt, maxToolTurns, maxTaskTokens, options.signal);
        await this.deps.limits.record(agent.providerId);
        await this.deps.context.append({ role: 'user', content: prompt });
        await this.deps.context.append({ role: 'assistant', content: result.response.content, agentId: agent.providerId });
        await this.deps.store.updateStatus(taskId, 'completed', { result: result.response.content.slice(0, 2000), usedTokens: result.response.usage.totalTokens });
        await this.finishGoal(goalId, prompt, now, 'completed');
        this.deps.emit({ state: 'completed', goalId, agentId: agent.providerId });
        return {
          result, attempts: attempt + 1,
          decision: { agentId: agent.providerId, agentName: agent.name, reason: agent.reason, limit: this.deps.limits.status(agent.providerId), skipped },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (options.signal?.aborted) {
          await this.deps.store.updateStatus(taskId, 'failed', { error: 'Cancelled by user.' });
          await this.finishGoal(goalId, prompt, now, 'failed');
          this.deps.emit({ state: 'failed', goalId, agentId: agent.providerId, detail: 'cancelled' });
          throw error;
        }
        if (isRateLimitMessage(message)) await this.deps.limits.recordRateLimit(agent.providerId, message);
        failures.push(`${agent.name}: ${message}`);
      }
    }
    await this.deps.store.updateStatus(taskId, 'failed', { error: failures.join(' | ').slice(0, 1000) });
    await this.finishGoal(goalId, prompt, now, 'failed');
    this.deps.emit({ state: 'failed', goalId, detail: failures.join(' | ') });
    throw new Error(`Every eligible agent failed: ${failures.join(' | ')}`);
  }

  private async candidates(): Promise<{ candidates: AgentCandidate[]; unavailable: Array<{ providerId: string; reason: string }> }> {
    const order = this.deps.fallbackOrder();
    const candidates: AgentCandidate[] = [];
    const unavailable: Array<{ providerId: string; reason: string }> = [];
    for (const provider of this.deps.providers()) {
      if (this.deps.isCredit(provider.id) && !this.deps.creditAllowed()) continue; // hidden entirely in subscription/free mode
      const models = provider.models.filter(model => this.deps.isPermitted(EXECUTOR.id, provider.id, model.id));
      if (!models.length) { unavailable.push({ providerId: provider.id, reason: 'not permitted for the executor role' }); continue; }
      let available = false;
      try { available = await provider.isAvailable(); } catch { available = false; }
      if (!available) { unavailable.push({ providerId: provider.id, reason: 'not signed in or not running' }); continue; }
      const limit = provider.getRateLimitStatus();
      const base = this.deps.limits.status(provider.id);
      const status: LimitStatus = limit.isLimited && base.available
        ? { ...base, available: false, reason: 'provider reports it is rate limited' } : base;
      const tier = models.reduce<Tier>((best, model) => TIER_RANK[model.tier] > TIER_RANK[best] ? model.tier : best, 'budget');
      const position = order.indexOf(provider.id);
      candidates.push({ providerId: provider.id, name: provider.name, tier, order: position < 0 ? order.length : position, status });
    }
    return { candidates, unavailable };
  }

  private async execute(providerId: string, prompt: string, maxToolTurns: number, maxTaskTokens: number, signal?: AbortSignal): Promise<OrchestratorResult> {
    const provider = this.deps.providers().find(item => item.id === providerId);
    const maxContext = Math.max(...(provider?.models.map(model => model.maxContextTokens) ?? [8000]));
    const window = Math.min(this.deps.settings().contextTokens, Math.floor(maxContext * 0.5));
    const messages: Message[] = [{ role: 'system', content: EXECUTOR_PROMPT }, ...this.deps.context.pack(prompt, window)];
    let used = 0;
    let latest: OrchestratorResult | undefined;
    for (let turn = 0; turn < Math.max(1, maxToolTurns); turn += 1) {
      latest = await this.deps.orchestrator.execute(messages, {
        signal, preferredProvider: providerId, strictProvider: true, agentId: EXECUTOR.id, maxTokens: Math.max(256, maxTaskTokens - used),
      });
      used += latest.response.usage.totalTokens;
      const match = TOOL_BLOCK.exec(latest.response.content);
      if (!match) break;
      let output: string;
      try {
        const call = JSON.parse(match[1]) as ToolCall;
        output = await this.deps.tools.executeCall(EXECUTOR, call);
        await this.noteToolUse(call, output);
      } catch (error) {
        output = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
      }
      messages.push({ role: 'assistant', content: latest.response.content });
      messages.push({ role: 'user', content: `TOOL RESULT:\n${output}\nContinue. If finished, answer without a tool_call.` });
      if (used >= maxTaskTokens) break;
    }
    if (!latest) throw new Error(`Agent ${providerId} produced no result.`);
    latest.response.content = latest.response.content.replace(new RegExp(TOOL_BLOCK.source, 'g'), '').trim() || '(the agent stopped after using its tool turns without a final answer)';
    latest.response.usage.totalTokens = used;
    return latest;
  }

  private async noteToolUse(call: ToolCall, output: string): Promise<void> {
    if (call.tool === 'read_file' && call.path) await this.deps.context.addNote(`read ${call.path} (${output.length} chars)`);
    else if (call.tool === 'write_file' && call.path) await this.deps.context.addNote(`wrote ${call.path}`);
    else if (call.tool === 'execute' && call.command) await this.deps.context.addNote(`ran ${[call.command, ...(call.args ?? [])].join(' ')}`);
  }

  private async finishGoal(goalId: string, prompt: string, createdAt: number, status: 'completed' | 'failed'): Promise<void> {
    const goal = this.deps.store.getGoal(goalId);
    await this.deps.store.putGoal({ ...(goal ?? { id: goalId, objective: prompt.slice(0, 500), taskIds: [], createdAt }), status, updatedAt: Date.now() });
  }

  private taskRecord(id: string, goalId: string, prompt: string, agentId: string, backups: string[], tokenBudget: number, now: number): TaskRecord {
    return {
      id, goalId, description: prompt.slice(0, 200), acceptanceCriteria: [], dependencies: [], status: 'queued',
      primaryAgentId: agentId, backupAgentIds: backups, tokenBudget, reservedTokens: 0, usedTokens: 0,
      attempt: 0, artifacts: [], createdAt: now, updatedAt: now,
    };
  }
}
