import type { MementoLike } from '../context/conversation-context';

/**
 * Subscription CLIs do not expose a "remaining quota" API, so remaining headroom is estimated from two signals:
 *  - a soft cap the user configures per agent (`ai-orchestra.limits`), counted against requests this extension made;
 *  - a cooldown started when the agent itself reports a rate limit.
 */
export interface LimitRule { requests?: number; windowHours?: number }

export interface LimitStatus {
  providerId: string;
  used: number;
  cap?: number;
  /** `Infinity` when no cap is configured. */
  remaining: number;
  windowResetsAt?: number;
  cooldownUntil?: number;
  available: boolean;
  reason?: string;
}

interface Persisted { events: Record<string, number[]>; cooldowns: Record<string, number> }

const KEY = 'ai-orchestra.limits.v1';
const HOUR = 3_600_000;
const DEFAULT_WINDOW_HOURS = 5;
const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const MAX_COOLDOWN_MS = 24 * HOUR;

export function isRateLimitMessage(text: string): boolean {
  return /rate.?limit|too many requests|\b429\b|usage limit|quota|limit (reached|exceeded)|try again (later|in)|overloaded/i.test(text);
}

/**
 * Reads "retry after 30 seconds" / "try again in 2 hours" / "try again at 6:39 PM" hints (the last is what Codex prints
 * when a subscription limit is hit); falls back to a conservative default.
 */
export function parseRetryDelayMs(text: string, now: number = Date.now()): number {
  const clock = /(?:try again|retry|resets?)\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(text);
  if (clock) {
    let hours = Number(clock[1]);
    const period = clock[3]?.toLowerCase();
    if (period === 'pm' && hours < 12) hours += 12;
    if (period === 'am' && hours === 12) hours = 0;
    if (hours < 24 && Number(clock[2]) < 60) {
      const target = new Date(now);
      target.setHours(hours, Number(clock[2]), 0, 0);
      let delta = target.getTime() - now;
      if (delta <= 0) delta += 24 * HOUR; // that time has already passed today, so it means tomorrow
      return Math.min(MAX_COOLDOWN_MS, Math.max(1000, delta));
    }
  }
  const match = /(?:retry|try again|resets?)[^0-9]{0,24}(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(text);
  if (!match) return DEFAULT_COOLDOWN_MS;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const ms = unit.startsWith('h') ? value * HOUR : unit.startsWith('m') ? value * 60_000 : value * 1000;
  return Math.min(MAX_COOLDOWN_MS, Math.max(1000, Math.round(ms)));
}

export class LimitTracker {
  private data: Persisted;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: MementoLike,
    private readonly rules: () => Record<string, LimitRule>,
    private readonly now: () => number = Date.now,
  ) {
    const saved = state.get<Persisted>(KEY, { events: {}, cooldowns: {} });
    this.data = { events: { ...saved.events }, cooldowns: { ...saved.cooldowns } };
  }

  public async record(providerId: string): Promise<void> {
    (this.data.events[providerId] ||= []).push(this.now());
    this.prune();
    await this.persist();
  }

  public async recordRateLimit(providerId: string, message: string): Promise<number> {
    const until = this.now() + parseRetryDelayMs(message, this.now());
    this.data.cooldowns[providerId] = until;
    await this.persist();
    return until;
  }

  public status(providerId: string): LimitStatus {
    const now = this.now();
    const rule = this.rules()[providerId] ?? {};
    const windowMs = (rule.windowHours ?? DEFAULT_WINDOW_HOURS) * HOUR;
    const inWindow = (this.data.events[providerId] ?? []).filter(at => at > now - windowMs);
    const cap = typeof rule.requests === 'number' && rule.requests > 0 ? rule.requests : undefined;
    const remaining = cap === undefined ? Number.POSITIVE_INFINITY : Math.max(0, cap - inWindow.length);
    const cooldown = this.data.cooldowns[providerId];
    const cooldownUntil = cooldown && cooldown > now ? cooldown : undefined;
    const windowResetsAt = cap !== undefined && remaining === 0 ? Math.min(...inWindow) + windowMs : undefined;
    const reason = cooldownUntil ? `rate-limited until ${new Date(cooldownUntil).toLocaleTimeString()}`
      : remaining === 0 ? `configured limit of ${cap} request(s) per ${rule.windowHours ?? DEFAULT_WINDOW_HOURS} h is used up`
        : undefined;
    return { providerId, used: inWindow.length, cap, remaining, windowResetsAt, cooldownUntil, available: !reason, reason };
  }

  public flush(): Promise<void> { return this.writes; }

  private prune(): void {
    const rules = this.rules();
    const cutoff = this.now() - Math.max(24, ...Object.values(rules).map(rule => rule.windowHours ?? DEFAULT_WINDOW_HOURS)) * HOUR;
    for (const [id, events] of Object.entries(this.data.events)) this.data.events[id] = events.filter(at => at > cutoff);
  }

  private persist(): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(this.data)) as Persisted;
    const write = this.writes.catch(() => undefined).then(() => this.state.update(KEY, snapshot));
    this.writes = write;
    write.catch(() => undefined);
    return write;
  }
}
