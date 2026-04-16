/**
 * Hand-rolled Levenshtein distance + fuzzy-match helper.
 *
 * Used by the CLI (#388.2) to suggest similar commands when the user
 * mistypes. No dependencies — classic two-row DP.
 */

/** Levenshtein edit distance between two strings. */
export function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Return up to `maxResults` candidates within `maxDistance` of `input`.
 * Case-insensitive; sorted by distance ascending (ties: alphabetical).
 */
export function fuzzyMatch(
  input: string,
  candidates: string[],
  maxResults = 3,
  maxDistance = 3,
): string[] {
  if (!input) return [];
  const lc = input.toLowerCase();
  const seen = new Set<string>();
  const scored: Array<{ name: string; d: number }> = [];
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    const d = distance(lc, c.toLowerCase());
    if (d <= maxDistance) scored.push({ name: c, d });
  }
  scored.sort((a, b) => a.d - b.d || a.name.localeCompare(b.name));
  return scored.slice(0, maxResults).map(s => s.name);
}
