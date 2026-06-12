export function sanitizeBranchName(name: string): string {
  // #823 Bug A — greedy strip of leading/trailing dashes/dots so unknown CLI
  // flags that leak into the positional slot (e.g. "--no-attach") sanitize to
  // "no-attach" rather than the half-stripped "-no-attach", which then
  // becomes a corrupted worktree name "1--no-attach" downstream.
  //
  // Strip pattern split into two anchored passes:
  //   - `^[-.]+`        — `^` anchor pins the start, no backtracking possible.
  //   - `(?<![-.])[-.]+$` — negative look-behind pins the trailing run to its
  //     leftmost start, preventing the n² backtrack CodeQL's js/polynomial-redos
  //     flags on the bare `[-.]+$` form (it can begin matching anywhere within
  //     the run, then backtrack on long all-dash input).
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._\-]/g, "")
    .replace(/\.{2,}/g, ".").replace(/^[-.]+/, "").replace(/(?<![-.])[-.]+$/, "").slice(0, 50);
}
