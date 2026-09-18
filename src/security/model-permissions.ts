import * as vscode from 'vscode';
import { AgentRole } from '../agents/types';
import { ProviderRegistry } from '../providers/provider-registry';

export type PermissionMode = 'open' | 'restricted';
type Assignments = Partial<Record<AgentRole, string[]>>;

interface PermissionState { mode: PermissionMode; assignments: Assignments; }

export class ModelPermissionManager {
  private readonly key = 'ai-orchestra.modelPermissions.v1';
  private state: PermissionState;

  constructor(private readonly workspaceState: vscode.Memento, private readonly registry: ProviderRegistry) {
    this.state = workspaceState.get<PermissionState>(this.key, { mode: 'open', assignments: {} });
  }

  public getMode(): PermissionMode { return this.state.mode; }
  public getAssignments(role: AgentRole): readonly string[] { return this.state.assignments[role] || []; }

  public isAllowed(agentId: string, providerId: string, modelId: string): boolean {
    if (this.state.mode === 'open') return true;
    const role = this.roleForAgent(agentId);
    const allowed = this.state.assignments[role] || [];
    return allowed.includes(`${providerId}:${modelId}`) || allowed.includes(`${providerId}:*`);
  }

  public async setMode(mode: PermissionMode): Promise<void> {
    this.state = { ...this.state, mode };
    await this.workspaceState.update(this.key, this.state);
  }

  public async setAssignments(role: AgentRole, modelKeys: string[]): Promise<void> {
    this.state = { ...this.state, assignments: { ...this.state.assignments, [role]: [...new Set(modelKeys)] } };
    await this.workspaceState.update(this.key, this.state);
  }

  public listModels(): Array<{ key: string; label: string; description: string }> {
    return this.registry.getAllProviders().flatMap(provider => provider.models.map(model => ({
      key: `${provider.id}:${model.id}`, label: model.name, description: provider.name,
    })));
  }

  private roleForAgent(agentId: string): AgentRole {
    if (agentId === 'supervisor') return 'supervisor';
    const role = agentId.split('-')[0] as AgentRole;
    return ['planner', 'coder', 'reviewer', 'auditor', 'tester'].includes(role) ? role : 'supervisor';
  }
}
