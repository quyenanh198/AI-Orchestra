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

  public getExpiredLeases(now = Date.now()): TaskRecord[] {
    return [...this.tasks.values()].filter(t => ['leased', 'running'].includes(t.status) && !!t.leaseExpiresAt && t.leaseExpiresAt <= now);
  }

  public async flush(): Promise<void> { await this.writes; }

  private persist(): Promise<void> {
    const snapshot: StoreSnapshot = { goals: [...this.goals.values()], tasks: [...this.tasks.values()] };
    this.writes = this.writes.then(() => this.state.update(this.key, snapshot));
    return this.writes;
  }
}
