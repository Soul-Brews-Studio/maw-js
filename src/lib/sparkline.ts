/**
 * sparkline — render a Unicode block-character sparkline from numeric values.
 *
 * Used by `maw costs --daily` to visualise per-day cost per agent.
 *
 * Block characters (index 0 = space sentinel, 1–8 = ▁..█):
 *   BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
 *
 * Absent-day marker: "░" (U+2591 LIGHT SHADE) — no sessions at all.
 */

const BLOCKS = " ▁▂▃▄▅▆▇█";

/**
 * Render a sparkline string from an array of numeric values.
 *
 * @param values      - cost per bucket (one entry per day window)
 * @param hadActivity - parallel boolean array: true if any session existed
 *                      that day, even if cost was 0.  Omit to auto-detect
 *                      (active = v > 0).
 * @returns           - string of Unicode chars, one per bucket
 *
 * Rules:
 *   !hadActivity[i]        → "░"  (no sessions — visually distinct from zero-cost)
 *   hadActivity[i] && max==0 → "▁"  (sessions exist but all free/cached)
 *   else                   → BLOCKS[round(v / max * 7) + 1]  (▁..█)
 */
export function sparkline(values: number[], hadActivity?: boolean[]): string {
  const max = Math.max(...values);
  return values
    .map((v, i) => {
      const active = hadActivity ? hadActivity[i] : v > 0;
      if (!active) return "░";
      if (max === 0) return "▁"; // sessions exist but zero cost (free tier / cache)
      const norm = Math.round((v / max) * 7); // 0..7
      return BLOCKS[norm + 1]; // offset +1: 0→▁, 7→█
    })
    .join("");
}
