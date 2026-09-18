import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { AgentCheckpoint, AgentDefinition, GoalRecord, TaskRecord } from '../agents/types';
import { BudgetManager } from '../budget/budget-manager';
import { Message } from '../providers/types';
import { Orchestrator, OrchestratorResult } from './orchestrator';
import { TaskStore } from './task-store';
import { ToolRuntime } from '../tools/tool-runtime';

export interface SupervisorEvent {
  goalId: string;
  taskId?: string;
  agentId?: string;
  state: string;
  detail?: string;
}

export class MultiAgentSupervisor implements vscode.Disposable {
  private readonly agents: AgentDefinition[] = [
    { id: 'planner-1', role: 'planner', providerPreference: 'auto', capabilities: ['workspace.read', 'provider.invoke'], backupFor: ['coder', 'auditor'] },
    { id: 'coder-1', role: 'coder', providerPreference: 'auto', capabilities: ['workspace.read', 'workspace.write', 'terminal.execute', 'provider.invoke'], backupFor: ['tester'] },
    { id: 'auditor-1', role: 'auditor', providerPreference: 'auto', capabilities: ['workspace.read', 'provider.invoke', 'task.verify'], backupFor: ['coder'] },
    { id: 'reviewer-1', role: 'reviewer', providerPreference: 'auto', capabilities: ['workspace.read', 'provider.invoke', 'task.verify'], backupFor: ['planner', 'auditor'] },
  ];
  private readonly events = new vscode.EventEmitter<SupervisorEvent>();
  public readonly onEvent = this.events.event;

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly store: TaskStore,
    private readonly budget: BudgetManager,
    private readonly tools: ToolRuntime,
  ) {}

  public getAgents(): readonly AgentDefinition[] { return this.agents; }
  public getTasks(goalId?: string): TaskRecord[] { return this.store.getTasks(goalId); }

  public async executeGoal(objective: string, signal?: AbortSignal): Promise<OrchestratorResult> {
    const goalId = crypto.randomUUID();
    const policy = this.budget.getTaskPolicy();
    const now = Date.now();
    const parallelSpecs = [
      { role: 'planner' as const, description: `Create an implementation plan for: ${objective}` },
      { role: 'coder' as const, description: `Implement the requested change in the workspace and verify it: ${objective}` },
      { role: 'auditor' as const, description: `Independently audit risks, missing requirements, and failure modes for: ${objective}` },
    ];
    const taskBudget = Math.max(1000, Math.floor(policy.maxTaskTokens / 5));
    const tasks = parallelSpecs.map(spec => this.newTask(goalId, spec.description, spec.role, taskBudget, policy.handoffThreshold, now));
    const goal: GoalRecord = { id: goalId, objective, taskIds: tasks.map(t => t.id), status: 'active', createdAt: now, updatedAt: now };
    await this.store.putGoal(goal);
    await Promise.all(tasks.map(t => this.store.putTask(t)));
    this.events.fire({ goalId, state: 'started', detail: objective });

    const concurrency = vscode.workspace.getConfiguration('ai-orchestra.agents').get('maxConcurrent', 3);
    const firstPass = await this.runLimited(tasks, concurrency, task => this.runTask(task, objective, signal));
    const reviewTask = this.newTask(
      goalId,
      `Review and reconcile the planner and auditor outputs for: ${objective}`,
      'reviewer', taskBudget, policy.handoffThreshold, Date.now(), tasks.map(t => t.id),
    );
    goal.taskIds.push(reviewTask.id);
    await this.store.putGoal(goal);
    await this.store.putTask(reviewTask);
    const reviewContext = firstPass.map((r, i) => `OUTPUT ${i + 1}:\n${r.response.content}`).join('\n\n');
    const reviewed = await this.runTask(reviewTask, `${objective}\n\n${reviewContext}`, signal);

    const supervisorBudget = Math.max(1000, policy.maxTaskTokens - taskBudget * 4);
    const finalMessages: Message[] = [
      { role: 'system', content: 'You are the main supervisor. Produce the final answer. Preserve requirements, resolve conflicts, identify anything not actually completed, and provide explicit handoff state.' },
      { role: 'user', content: `${objective}\n\nVERIFIED REVIEW:\n${reviewed.response.content}` },
    ];
    const finalResult = await this.orchestrator.execute(finalMessages, { signal, maxTokens: supervisorBudget, agentId: 'supervisor' });
    await this.store.putGoal({ ...goal, status: 'completed', updatedAt: Date.now() });
    this.events.fire({ goalId, state: 'completed' });
    return finalResult;
  }

  public async recoverExpiredLeases(signal?: AbortSignal): Promise<void> {
    for (const task of this.store.getExpiredLeases()) {
      const backup = this.pickBackup(task);
      if (!backup) {
        await this.store.updateStatus(task.id, 'failed', { error: 'Lease expired and no backup agent is available.' });
        continue;
      }
      await this.store.updateStatus(task.id, 'handoff', { primaryAgentId: backup.id });
      this.events.fire({ goalId: task.goalId, taskId: task.id, agentId: backup.id, state: 'handoff', detail: 'lease-expired' });
      await this.runTask({ ...task, primaryAgentId: backup.id, status: 'handoff' }, task.checkpoint?.summary || task.description, signal);
    }
  }

  private async runTask(task: TaskRecord, context: string, signal?: AbortSignal): Promise<OrchestratorResult> {
    const primary = this.agents.find(a => a.id === task.primaryAgentId) || this.pickAgent(task);
    if (!primary) throw new Error(`No agent can execute task ${task.id}.`);
    const leaseMs = vscode.workspace.getConfiguration('ai-orchestra.agents').get('leaseSeconds', 90) * 1000;
    const leased = await this.store.leaseTask(task.id, primary.id, leaseMs);
    if (!leased) throw new Error(`Could not lease task ${task.id}.`);
    this.events.fire({ goalId: task.goalId, taskId: task.id, agentId: primary.id, state: 'running' });
    const heartbeatTimer = setInterval(
      () => void this.store.heartbeat(task.id, primary.id, leaseMs),
      Math.max(5_000, Math.floor(leaseMs / 3)),
    );

    const reserveForHandoff = Math.max(256, Math.floor(task.tokenBudget * task.handoffThreshold));
    const primaryMax = Math.max(256, task.tokenBudget - reserveForHandoff);
    try {
      const result = await this.invokeAgent(primary, task, context, primaryMax, signal);
      const used = result.response.usage.totalTokens;
      const needsHandoff = /length|max_tokens/i.test(result.response.finishReason) || used >= primaryMax;
      if (needsHandoff && reserveForHandoff > 0) {
        const checkpoint = this.checkpoint(result.response.content, task, 'budget-low');
        await this.store.updateStatus(task.id, 'handoff', { checkpoint, usedTokens: used });
        const backup = this.pickBackup(task, primary.id);
        if (backup) {
          clearInterval(heartbeatTimer);
          await this.store.updateStatus(task.id, 'handoff', { primaryAgentId: backup.id, leaseExpiresAt: Date.now() });
          await this.store.leaseTask(task.id, backup.id, leaseMs);
          const backupHeartbeat = setInterval(
            () => void this.store.heartbeat(task.id, backup.id, leaseMs),
            Math.max(5_000, Math.floor(leaseMs / 3)),
          );
          this.events.fire({ goalId: task.goalId, taskId: task.id, agentId: backup.id, state: 'handoff', detail: 'budget-low' });
          let continuation: OrchestratorResult;
          try {
            continuation = await this.invokeAgent(backup, task, `Continue from this checkpoint without repeating completed work:\n${JSON.stringify(checkpoint)}\n\nOriginal context:\n${context}`, reserveForHandoff, signal);
          } finally {
            clearInterval(backupHeartbeat);
          }
          const content = `${result.response.content}\n${continuation.response.content}`;
          const totalTokens = used + continuation.response.usage.totalTokens;
          const merged = { ...continuation, response: { ...continuation.response, content, usage: { ...continuation.response.usage, totalTokens } } };
          await this.store.updateStatus(task.id, 'completed', { result: content, usedTokens: totalTokens, primaryAgentId: backup.id });
          return merged;
        }
      }
      await this.store.updateStatus(task.id, 'completed', { result: result.response.content, usedTokens: used });
      return result;
    } catch (error) {
      const checkpoint: AgentCheckpoint = task.checkpoint || {
        summary: `Primary agent failed before completion: ${error instanceof Error ? error.message : String(error)}`,
        completed: [], remaining: [task.description], decisions: [], blockers: [], artifacts: task.artifacts, updatedAt: Date.now(),
      };
      const backup = this.pickBackup(task, primary.id);
      if (!backup) {
        await this.store.updateStatus(task.id, 'failed', { checkpoint, error: checkpoint.summary });
        throw error;
      }
      clearInterval(heartbeatTimer);
      await this.store.updateStatus(task.id, 'handoff', { checkpoint, primaryAgentId: backup.id, leaseExpiresAt: Date.now() });
      await this.store.leaseTask(task.id, backup.id, leaseMs);
      const backupHeartbeat = setInterval(
        () => void this.store.heartbeat(task.id, backup.id, leaseMs),
        Math.max(5_000, Math.floor(leaseMs / 3)),
      );
      this.events.fire({ goalId: task.goalId, taskId: task.id, agentId: backup.id, state: 'handoff', detail: 'provider-error' });
      let result: OrchestratorResult;
      try {
        result = await this.invokeAgent(backup, task, `${context}\n\nHANDOFF:\n${JSON.stringify(checkpoint)}`, task.tokenBudget, signal);
      } finally {
        clearInterval(backupHeartbeat);
      }
      await this.store.updateStatus(task.id, 'completed', { result: result.response.content, usedTokens: result.response.usage.totalTokens, primaryAgentId: backup.id });
      return result;
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  private async invokeAgent(agent: AgentDefinition, task: TaskRecord, context: string, maxTokens: number, signal?: AbortSignal): Promise<OrchestratorResult> {
    const messages: Message[] = [
      { role: 'system', content: `You are worker ${agent.id}, role=${agent.role}. Complete only your assigned task. State evidence, decisions, artifacts and remaining work so a backup can continue. Never claim tools or edits you did not perform. Available tool protocol: emit exactly <tool_call>{"tool":"read_file|write_file|execute",...}</tool_call>. You may only use capabilities assigned to your role.` },
      { role: 'user', content: `TASK: ${task.description}\nACCEPTANCE: ${task.acceptanceCriteria.join('; ')}\nCONTEXT:\n${context}` },
    ];
    let used = 0;
    let latest: OrchestratorResult | undefined;
    for (let turn = 0; turn < 4; turn += 1) {
      latest = await this.orchestrator.execute(messages, { signal, preferredProvider: agent.providerPreference, maxTokens: Math.max(256, maxTokens - used), agentId: agent.id });
      used += latest.response.usage.totalTokens;
      const match = latest.response.content.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
      if (!match) {
        latest.response.usage.totalTokens = used;
        return latest;
      }
      let output: string;
      try {
        const call = JSON.parse(match[1]) as { tool: string; path?: string; content?: string; command?: string; args?: string[] };
        output = await this.tools.executeCall(agent, call);
      } catch (error) {
        output = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
      }
      messages.push({ role: 'assistant', content: latest.response.content });
      messages.push({ role: 'user', content: `TOOL RESULT:\n${output}\nContinue the task. If finished, return evidence and no tool_call.` });
      if (used >= maxTokens) break;
    }
    if (!latest) throw new Error(`Agent ${agent.id} produced no result.`);
    latest.response.usage.totalTokens = used;
    return latest;
  }

  private async runLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await fn(items[index]);
      }
    });
    await Promise.all(workers);
    return results;
  }

  private newTask(goalId: string, description: string, role: AgentDefinition['role'], tokenBudget: number, handoffThreshold: number, now: number, dependencies: string[] = []): TaskRecord {
    const primary = this.agents.find(a => a.role === role)!;
    return {
      id: crypto.randomUUID(), goalId, description,
      acceptanceCriteria: ['Address the assigned scope', 'Report evidence and remaining work', 'Do not claim unverified completion'],
      dependencies, status: 'queued', primaryAgentId: primary.id,
      backupAgentIds: this.agents.filter(a => a.id !== primary.id && a.backupFor.includes(role)).map(a => a.id),
      tokenBudget, reservedTokens: tokenBudget, usedTokens: 0, handoffThreshold,
      attempt: 0, artifacts: [], createdAt: now, updatedAt: now,
    };
  }

  private pickAgent(task: TaskRecord): AgentDefinition | undefined {
    return this.agents.find(a => a.id === task.primaryAgentId) || this.agents[0];
  }

  private pickBackup(task: TaskRecord, excluding?: string): AgentDefinition | undefined {
    return task.backupAgentIds.map(id => this.agents.find(a => a.id === id)).find((a): a is AgentDefinition => !!a && a.id !== excluding);
  }

  private checkpoint(content: string, task: TaskRecord, reason: string): AgentCheckpoint {
    return {
      summary: content.slice(-6000), completed: ['Primary agent response captured'], remaining: [`Continue task after ${reason}`],
      decisions: [], blockers: [reason], artifacts: task.artifacts, updatedAt: Date.now(),
    };
  }

  public dispose(): void { this.events.dispose(); }
}
