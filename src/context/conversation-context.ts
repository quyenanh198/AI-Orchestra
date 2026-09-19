import type { Message } from '../providers/types';

/** Structural subset of `vscode.Memento`, so this module stays unit-testable without `vscode`. */
export interface MementoLike {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface Turn { role: 'user' | 'assistant'; content: string; agentId?: string; at: number }
interface Snapshot { turns: Turn[]; digest: string[]; notes: string[] }

export interface ContextOptions {
  /** Verbatim turns kept before older ones are folded into the digest. */
  recentTurns: number;
  digestLineChars: number;
  maxDigestLines: number;
  maxNotes: number;
  estimate: (text: string) => number;
}

const KEY = 'ai-orchestra.context.v1';
const oneLine = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

/**
 * The shared "context window": every executor agent reads this instead of re-deriving what already happened.
 * Older turns are compacted deterministically (no model call, so no subscription quota is spent on it).
 */
export class ConversationContext {
  private snapshot: Snapshot;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly state: MementoLike, private readonly options: ContextOptions) {
    const saved = state.get<Snapshot>(KEY, { turns: [], digest: [], notes: [] });
    this.snapshot = { turns: [...saved.turns], digest: [...saved.digest], notes: [...saved.notes] };
  }

  public get turns(): readonly Turn[] { return this.snapshot.turns; }
  public get digest(): readonly string[] { return this.snapshot.digest; }
  public get notes(): readonly string[] { return this.snapshot.notes; }

  public async append(turn: Omit<Turn, 'at'> & { at?: number }): Promise<void> {
    this.snapshot.turns.push({ ...turn, at: turn.at ?? Date.now() });
    this.compact();
    await this.persist();
  }

  /** Facts a later agent should not have to rediscover, e.g. "read src/a.ts (1.2 KB)". */
  public async addNote(note: string): Promise<void> {
    const line = oneLine(note, 200);
    if (!line || this.snapshot.notes.includes(line)) return;
    this.snapshot.notes.push(line);
    while (this.snapshot.notes.length > this.options.maxNotes) this.snapshot.notes.shift();
    await this.persist();
  }

  public async clear(): Promise<void> {
    this.snapshot = { turns: [], digest: [], notes: [] };
    await this.persist();
  }

  /**
   * Builds the messages for the next agent: one system message (digest + notes) and the recent turns, newest
   * first until `budgetTokens` is spent, then the new prompt. The prompt is always included.
   */
  public pack(prompt: string, budgetTokens: number): Message[] {
    const { estimate } = this.options;
    let remaining = Math.max(0, budgetTokens - estimate(prompt));
    const turns: Turn[] = [];
    for (let index = this.snapshot.turns.length - 1; index >= 0; index -= 1) {
      const cost = estimate(this.snapshot.turns[index].content) + 4;
      if (cost > remaining) break;
      remaining -= cost;
      turns.unshift(this.snapshot.turns[index]);
    }
    const digest = this.takeNewest(this.snapshot.digest, () => remaining, spent => { remaining -= spent; });
    const notes = this.takeNewest(this.snapshot.notes, () => remaining, spent => { remaining -= spent; });
    const messages: Message[] = [];
    if (digest.length || notes.length) {
      const sections = ['Shared context from earlier in this conversation. It was gathered by previous agents; use it instead of re-reading or asking again.'];
      if (digest.length) sections.push('Earlier conversation (oldest first):', ...digest.map(line => `- ${line}`));
      if (notes.length) sections.push('Workspace notes:', ...notes.map(line => `- ${line}`));
      messages.push({ role: 'system', content: sections.join('\n') });
    }
    for (const turn of turns) messages.push({ role: turn.role, content: turn.content });
    messages.push({ role: 'user', content: prompt });
    return messages;
  }

  public flush(): Promise<void> { return this.writes; }

  private takeNewest(lines: string[], budget: () => number, spend: (tokens: number) => void): string[] {
    const chosen: string[] = [];
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const cost = this.options.estimate(lines[index]) + 2;
      if (cost > budget()) break;
      spend(cost);
      chosen.unshift(lines[index]);
    }
    return chosen;
  }

  private compact(): void {
    const { recentTurns, digestLineChars, maxDigestLines } = this.options;
    while (this.snapshot.turns.length > recentTurns) {
      const turn = this.snapshot.turns.shift() as Turn;
      const who = turn.role === 'user' ? 'User' : `Agent ${turn.agentId ?? ''}`.trim();
      this.snapshot.digest.push(`${who}: ${oneLine(turn.content, digestLineChars)}`);
    }
    while (this.snapshot.digest.length > maxDigestLines) this.snapshot.digest.shift();
  }

  private persist(): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(this.snapshot)) as Snapshot;
    const write = this.writes.catch(() => undefined).then(() => this.state.update(KEY, snapshot));
    this.writes = write;
    write.catch(() => undefined);
    return write;
  }
}
