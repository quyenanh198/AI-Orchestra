import type { DelegationSupervisor } from '../orchestrator/delegation-supervisor';
import type { LimitStatus } from '../orchestrator/limit-tracker';

/** One-line, human-readable remaining headroom for an agent. */
export function describeLimit(status: LimitStatus): string {
  if (status.cooldownUntil) return `paused until ${new Date(status.cooldownUntil).toLocaleTimeString()} (rate limited)`;
  if (status.cap === undefined) return 'no limit configured';
  if (status.remaining === 0) return `limit used up (${status.used}/${status.cap})`;
  return `${status.remaining}/${status.cap} requests left`;
}

export interface AgentView { id: string; label: string; limit: string; available: boolean }

/** What the chat panel, sidebar and agent picker show: the agents the supervisor could delegate to right now. */
export async function agentViews(delegation: Pick<DelegationSupervisor, 'listAgents' | 'getPinned'>): Promise<{ agents: AgentView[]; pinned?: string }> {
  const agents = (await delegation.listAgents()).map(agent => ({
    id: agent.providerId, label: agent.name, limit: describeLimit(agent.status), available: agent.status.available,
  }));
  return { agents, pinned: delegation.getPinned() };
}
