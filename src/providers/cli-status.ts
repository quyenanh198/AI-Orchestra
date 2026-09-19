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

/** execFile errors embed the full argv in `message` — which for chat calls is the entire prompt. Never surface that. */
export function describeCliFailure(name: string, error: unknown): string {
  const e = (error ?? {}) as { code?: unknown; killed?: boolean; signal?: string; stderr?: unknown; name?: string };
  if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return `${name} request was cancelled.`;
  if (e.killed && e.signal) return `${name} timed out and was terminated.`;
  const stderr = typeof e.stderr === 'string' ? e.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 500) : '';
  const code = typeof e.code === 'string' || typeof e.code === 'number' ? ` (${e.code})` : '';
  return `${name} failed${code}${stderr ? `: ${stderr}` : ''}`;
}

export function parseCliJson<T>(name: string, stdout: string): T {
  const start = stdout.indexOf('{');
  try { return JSON.parse(start >= 0 ? stdout.slice(start) : stdout) as T; }
  catch { throw new Error(`${name} returned output that is not valid JSON.`); }
}
