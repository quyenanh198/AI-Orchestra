/** Pure helpers for account-backed CLI providers (no `vscode` import, so unit-testable). */

export interface CliAuthVerdict { authenticated: boolean; accountType?: string; error?: string }

// "Not logged in" contains "logged in", so success must never be inferred from a bare keyword match.
const AUTH_HINT = /not logged in|not authenticated|log ?in required|sign ?in required|authentication required|unauthori[sz]ed|please (log ?in|sign ?in)|run .{0,24}login/i;

export function classifyCodex(output: string): CliAuthVerdict {
  if (AUTH_HINT.test(output)) return { authenticated: false, error: 'Codex reports no signed-in session.' };
  const chatgpt = /chatgpt/i.test(output);
  if (/api key/i.test(output) && !chatgpt) {
    return { authenticated: false, accountType: 'API key', error: 'Codex is logged in with an API key (billed per token). Log in with a ChatGPT account to use it in Subscription mode.' };
  }
  return { authenticated: chatgpt || /logged in/i.test(output), accountType: chatgpt ? 'ChatGPT' : undefined };
}

/** Antigravity and Grok have no dedicated status command, so empty output is treated as "unverified", not "signed in". */
export function classifySessionProbe(output: string, accountType: string, name: string): CliAuthVerdict {
  if (!output.trim() || AUTH_HINT.test(output)) {
    return { authenticated: false, accountType, error: `${name} did not confirm a signed-in session. Run its login command in a terminal.` };
  }
  return { authenticated: true, accountType };
}

/**
 * Several CLIs report failures (notably rate limits) as JSON on stdout, not stderr:
 *  - Codex: `{"type":"error","message":"You've hit your usage limit ... try again at 6:39 PM."}` / `turn.failed`
 *  - Claude Code: `{"is_error":true,"result":"..."}`
 * Returns the human-readable message, if any.
 */
export function extractCliError(stdout: string): string | undefined {
  let found: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: { type?: string; message?: string; is_error?: boolean; result?: string; errors?: unknown; error?: string | { message?: string } };
    try { event = JSON.parse(trimmed); } catch { continue; }
    const nested = typeof event.error === 'string' ? event.error : event.error?.message;
    const listed = Array.isArray(event.errors) ? event.errors.filter((item): item is string => typeof item === 'string').join('; ') : '';
    if ((event.type === 'error' || event.type === 'turn.failed') && (event.message || nested)) found = event.message || nested;
    else if (event.is_error && typeof event.result === 'string' && event.result) found = event.result;
    else if (event.is_error && listed) found = listed;
  }
  return found?.replace(/\s+/g, ' ').slice(0, 500);
}

/** execFile errors embed the full argv in `message` — which for chat calls is the entire prompt. Never surface that. */
export function describeCliFailure(name: string, error: unknown): string {
  const e = (error ?? {}) as { code?: unknown; killed?: boolean; signal?: string; stderr?: unknown; stdout?: unknown; name?: string };
  if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return `${name} request was cancelled.`;
  if (e.killed && e.signal) return `${name} timed out and was terminated.`;
  const stderr = typeof e.stderr === 'string' ? e.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 500) : '';
  const reported = typeof e.stdout === 'string' ? extractCliError(e.stdout) : undefined;
  const detail = [reported, stderr].filter(Boolean).join(' | ');
  const code = typeof e.code === 'string' || typeof e.code === 'number' ? ` (${e.code})` : '';
  return `${name} failed${code}${detail ? `: ${detail}` : ''}`;
}

export function parseCliJson<T>(name: string, stdout: string): T {
  const start = stdout.indexOf('{');
  try { return JSON.parse(start >= 0 ? stdout.slice(start) : stdout) as T; }
  catch { throw new Error(`${name} returned output that is not valid JSON.`); }
}
