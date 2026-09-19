/**
 * Network chunks do not align with NDJSON line boundaries: a JSON object can be split across two chunks.
 * Keep the trailing partial line in `rest` and only emit complete lines.
 */
export function splitNdjson(pending: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (pending + chunk).split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.map(line => line.trim()).filter(Boolean), rest };
}
