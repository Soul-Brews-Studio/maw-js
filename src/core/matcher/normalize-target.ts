/**
 * Canonical target-name normalization for user-typed verb arguments.
 *
 * Why this exists:
 *   Shell completion (`ls`-style tab complete on a directory) and copy-paste
 *   from file managers routinely leave trailing slashes on a name. The bare
 *   form `maw wake token-oracle/` was failing lookup because "token-oracle/"
 *   is not the same string as "token-oracle" — the resolver refused to match.
 *
 *   Rather than patching each lookup site to strip slashes defensively, this
 *   helper centralizes the rule: every verb that takes a bare target/name
 *   runs the input through here first, so downstream code sees a clean name.
 *
 * Rules (applied repeatedly until stable, so stacked suffixes collapse):
 *   - trailing `.git` or `.git/` → stripped
 *   - trailing `/` (one or many) → stripped
 *   - leading/trailing whitespace → trimmed (once, up front)
 *
 * Examples:
 *   "foo"          → "foo"
 *   "foo/"         → "foo"
 *   "foo//"        → "foo"
 *   "foo/.git"     → "foo"
 *   "foo/.git/"    → "foo"
 *   "  foo/  "     → "foo"
 *   ""             → ""        // empty stays empty — callers surface the usage error
 *
 * Non-goals:
 *   - This does NOT parse URLs or org/repo slugs (see `parseWakeTarget` for
 *     that). It only cleans up user-typing artifacts on an already-bare name.
 *   - It does NOT lowercase or otherwise mutate internal characters; case
 *     handling is the resolver's job.
 */

export function normalizeTarget(raw: string): string {
  if (typeof raw !== "string") return "";
  let s = raw.trim();
  if (s === "") return "";

  // Loop: strip trailing `.git`, `.git/`, and plain `/` in any order.
  // A single pass misses stacked forms like `foo/.git/` — we want the
  // `.git` stripped AND the surrounding slashes cleaned up. Cheap, bounded.
  let prev: string;
  do {
    prev = s;
    // trailing slashes (one or many) — non-regex to avoid CodeQL polynomial-redos flag
    while (s.endsWith("/")) s = s.slice(0, -1);
    // trailing `.git` once the slashes are gone
    if (s.endsWith("/.git")) s = s.slice(0, -"/.git".length);
  } while (s !== prev);

  return s;
}
