import * as vscode from 'vscode';
import { GoalRecord, TaskRecord, TaskStatus, AgentCheckpoint } from '../agents/types';

interface StoreSnapshot {
  goals: GoalRecord[];
  tasks: TaskRecord[];
}

export class TaskStore {
  private readonly key = 'ai-orchestra.orchestration.v1';
  private goals = new Map<string, GoalRecord>();
  private tasks = new Map<string, TaskRecord>();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly state: vscode.Memento) {
    const snapshot = state.get<StoreSnapshot>(this.key, { goals: [], tasks: [] });
    for (const goal of snapshot.goals) this.goals.set(goal.id, goal);
    for (const task of snapshot.tasks) this.tasks.set(task.id, task);
  }

  public async putGoal(goal: GoalRecord): Promise<void> {
    this.goals.set(goal.id, { ...goal, updatedAt: Date.now() });
    await this.persist();
  }

  public async putTask(task: TaskRecord): Promise<void> {
    this.tasks.set(task.id, { ...task, updatedAt: Date.now() });
    await this.persist();
  }

  public getGoal(id: string): GoalRecord | undefined { return this.goals.get(id); }
  public getTask(id: string): TaskRecord | undefined { return this.tasks.get(id); }
  public getTasks(goalId?: string): TaskRecord[] {
    return [...this.tasks.values()].filter(t => !goalId || t.goalId === goalId);
  }

  public async leaseTask(taskId: string, agentId: string, leaseMs: number, now = Date.now()): Promise<TaskRecord | undefined> {
    const task = this.tasks.get(taskId);
    if (!task || task.status === 'completed') return undefined;
    if (task.leaseExpiresAt && task.leaseExpiresAt > now && task.primaryAgentId !== agentId) return undefined;
    const next: TaskRecord = {
      ...task, primaryAgentId: agentId, status: 'leased', heartbeatAt: now,
      leaseExpiresAt: now + leaseMs, attempt: task.attempt + 1, updatedAt: now,
    };
    this.tasks.set(taskId, next);
    await this.persist();
    return next;
  }

  public async heartbeat(taskId: string, agentId: string, leaseMs: number, checkpoint?: AgentCheckpoint): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.primaryAgentId !== agentId || task.status === 'completed') return false;
    const now = Date.now();
    this.tasks.set(taskId, { ...task, status: 'running', heartbeatAt: now, leaseExpiresAt: now + leaseMs, checkpoint: checkpoint || task.checkpoint, updatedAt: now });
    await this.persist();
    return true;
  }

  public async updateStatus(taskId: string, status: TaskStatus, patch: Partial<TaskRecord> = {}): Promise<TaskRecord | undefined> {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const next = { ...task, ...patch, id: task.id, goalId: task.goalId, status, updatedAt: Date.now() };
    this.tasks.set(taskId, next);
    await this.persist();
    return next;
  }

  /**
   * Tasks still leased/running when this store is loaded belong to a previous session (its heartbeat died with
   * the process). Resuming them silently would re-run write/execute-capable agents without user consent, so
   * they are failed instead; the user can re-issue the goal.
   */
  public async failInterrupted(now = Date.now()): Promise<number> {
    let count = 0;
    for (const [id, task] of this.tasks) {
      if (!['leased', 'running', 'handoff', 'queued'].includes(task.status)) continue;
      this.tasks.set(id, { ...task, status: 'failed', error: 'Interrupted: the previous session ended before this task finished.', updatedAt: now });
      count += 1;
    }
    for (const [id, goal] of this.goals) if (goal.status === 'active') this.goals.set(id, { ...goal, status: 'failed', updatedAt: now });
    if (count) await this.persist();
    return count;
  }

  public getExpiredLeases(now = Date.now()): TaskRecord[] {
    return [...this.tasks.values()].filter(t => ['leased', 'running'].includes(t.status) && !!t.leaseExpiresAt && t.leaseExpiresAt <= now);
  }

  public async flush(): Promise<void> { await this.writes; }

  private persist(): Promise<void> {
    const snapshot: StoreSnapshot = { goals: [...this.goals.values()], tasks: [...this.tasks.values()] };
    // `.catch` first: one failed write must not poison every later write in the chain.
    const write = this.writes.catch(() => undefined).then(() => this.state.update(this.key, snapshot));
    this.writes = write;
    write.catch(() => undefined);
    return write;
  }
}
