export type AgentRole = 'supervisor' | 'planner' | 'coder' | 'reviewer' | 'auditor' | 'tester';
export type AgentCapability =
  | 'workspace.read'
  | 'workspace.write'
  | 'terminal.execute'
  | 'provider.invoke'
  | 'task.assign'
  | 'task.verify';

export type TaskStatus = 'queued' | 'leased' | 'running' | 'handoff' | 'verifying' | 'completed' | 'failed';

export interface ArtifactRef {
  kind: 'text' | 'file' | 'diff' | 'command-output';
  uri?: string;
  content?: string;
  createdBy: string;
}

export interface AgentCheckpoint {
  summary: string;
  completed: string[];
  remaining: string[];
  decisions: string[];
  blockers: string[];
  artifacts: ArtifactRef[];
  updatedAt: number;
}

export interface AgentDefinition {
  id: string;
  role: AgentRole;
  providerPreference: string;
  capabilities: AgentCapability[];
  backupFor: AgentRole[];
}

export interface TaskRecord {
  id: string;
  goalId: string;
  description: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  status: TaskStatus;
  primaryAgentId?: string;
  backupAgentIds: string[];
  tokenBudget: number;
  reservedTokens: number;
  usedTokens: number;
  handoffThreshold?: number;
  leaseExpiresAt?: number;
  heartbeatAt?: number;
  attempt: number;
  checkpoint?: AgentCheckpoint;
  artifacts: ArtifactRef[];
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface GoalRecord {
  id: string;
  objective: string;
  taskIds: string[];
  status: 'active' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
}

export interface HandoffPacket {
  taskId: string;
  fromAgentId: string;
  toAgentId: string;
  reason: 'budget-low' | 'context-low' | 'rate-limit' | 'timeout' | 'provider-error' | 'lease-expired';
  checkpoint: AgentCheckpoint;
  remainingTokens: number;
}
