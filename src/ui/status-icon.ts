/** Maps a provider status string to a codicon id. Pure, so it is unit-testable without `vscode`. */
export function iconForStatus(status: string): string {
  // Negative states first: "Not authenticated" and "Not available" contain the positive words.
  if (/\bnot (authenticated|available|installed|configured|running)\b/i.test(status) || /sign in required|logout pending/i.test(status)) {
    return /not running/i.test(status) ? 'debug-disconnect' : 'x';
  }
  if (/rate limited/i.test(status)) return 'warning';
  if (/previously authenticated|checking/i.test(status)) return 'sync';
  if (/available|authenticated|signed in/i.test(status)) return 'check';
  return 'circle-outline';
}
