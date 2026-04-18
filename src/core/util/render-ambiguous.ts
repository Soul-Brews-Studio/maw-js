/**
 * Render AmbiguousMatchError as a clean, actionable CLI message (#567).
 *
 * Pre-#567 the raw error (plus minified bundle frames) leaked to stderr.
 * Now the top-level CLI catch calls this to produce:
 *
 *   error: 'X' matches N candidates:
 *     • candidate-1
 *     • candidate-2
 *   rerun with one of:
 *     maw hey candidate-1 "..."
 *     maw hey candidate-2 "..."
 *
 * Colour scheme matches the rest of the CLI (red for error, cyan for hint).
 */
import { AmbiguousMatchError } from "../runtime/find-window";

const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

/**
 * Reconstruct a rerun-hint command line from the original argv and a
 * candidate. We locate the ambiguous query in argv (first occurrence)
 * and substitute the candidate. Falls back to `maw <verb> <candidate>`
 * if argv doesn't contain the query verbatim (e.g. resolved via alias).
 */
function buildRerunHint(argv: string[], query: string, candidate: string): string {
  const quoteIfNeeded = (s: string): string => (s.includes(" ") ? `"${s}"` : s);
  const idx = argv.indexOf(query);
  if (idx === -1) {
    const verb = argv[0] ?? "hey";
    return `maw ${verb} ${candidate} "..."`;
  }
  const parts = argv.slice();
  parts[idx] = candidate;
  return `maw ${parts.map(quoteIfNeeded).join(" ")}`;
}

export function renderAmbiguousMatch(err: AmbiguousMatchError, argv: string[]): string {
  const lines: string[] = [];
  lines.push(`${RED}error${RESET}: '${err.query}' matches ${err.candidates.length} candidates:`);
  for (const c of err.candidates) lines.push(`  • ${c}`);
  lines.push(`${CYAN}rerun with one of:${RESET}`);
  for (const c of err.candidates) lines.push(`  ${buildRerunHint(argv, err.query, c)}`);
  return lines.join("\n");
}
