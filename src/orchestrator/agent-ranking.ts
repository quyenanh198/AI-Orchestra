import type { LimitStatus } from './limit-tracker';

export type Tier = 'budget' | 'standard' | 'premium';

export interface AgentCandidate {
  providerId: string;
  name: string;
  /** Best tier among the agent's models. */
  tier: Tier;
  /** Position in the user's `routing.fallbackOrder`; lower is preferred on ties. */
  order: number;
  status: LimitStatus;
}

export interface RankedAgent { providerId: string; name: string; score: number; reason: string }
export interface RankResult { ranked: RankedAgent[]; rejected: Array<{ providerId: string; reason: string }> }

const RANK: Record<Tier, number> = { budget: 0, standard: 1, premium: 2 };

/**
 * Pure supervisor policy: choose which single agent should execute a prompt. It costs no model call.
 *  - an agent with no headroom (cooldown or used-up cap) is never chosen;
 *  - the agent whose tier matches the task wins; a stronger agent is mildly penalised so premium quota is kept
 *    for tasks that need it, a weaker one is penalised more;
 *  - remaining headroom (fraction of the configured cap) breaks near-ties, then the configured order.
 * `pinned` (user override) restricts the choice to one agent, but still refuses one that is out of headroom.
 */
export function rankAgents(candidates: AgentCandidate[], wanted: Tier, pinned?: string): RankResult {
  const rejected: RankResult['rejected'] = [];
  const ranked: RankedAgent[] = [];
  for (const candidate of candidates) {
    if (pinned && candidate.providerId !== pinned) continue;
    if (!candidate.status.available) {
      rejected.push({ providerId: candidate.providerId, reason: candidate.status.reason ?? 'no headroom' });
      continue;
    }
    const gap = RANK[candidate.tier] - RANK[wanted];
    const fit = gap >= 0 ? 1 - 0.25 * gap : 0.4 + 0.2 * gap;
    const headroom = candidate.status.cap ? candidate.status.remaining / candidate.status.cap : 1;
    const score = fit * 10 + headroom * 5 - candidate.order * 0.1;
    const parts = [
      gap === 0 ? `${candidate.tier} tier matches the ${wanted} task` : gap > 0 ? `${candidate.tier} tier covers the ${wanted} task` : `${candidate.tier} tier is below the ${wanted} task`,
      candidate.status.cap ? `${candidate.status.remaining}/${candidate.status.cap} requests left` : 'no configured limit',
    ];
    ranked.push({ providerId: candidate.providerId, name: candidate.name, score, reason: parts.join('; ') });
  }
  ranked.sort((a, b) => b.score - a.score);
  return { ranked, rejected };
}
