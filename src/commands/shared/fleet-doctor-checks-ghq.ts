/**
 * fleet-doctor-checks-ghq — doubled `github.com/github.com/` ghq paths (#2578).
 *
 * A misconfigured ghq root (one that already ends in `.../github.com`) makes
 * ghq clone into a DOUBLED `…/github.com/github.com/<org>/<repo>` path. Both the
 * doubled and the canonical clone then show up in `ghq list`, which is the
 * resolution hazard #2577 fixed. This check surfaces the mess so an operator can
 * clean it up — it NEVER deletes anything (`fixable: false`); it only reports
 * each doubled path, whether the canonical copy exists, and a recommendation.
 *
 * Separated from fleet-doctor-checks.ts (like checks-repo) because it touches
 * the filesystem via `existsSync` — injected here so the check stays unit-
 * testable without a real ghq tree.
 */

import { existsSync } from "fs";
import type { DoctorFinding } from "./fleet-doctor-checks";

const DOUBLED_RE = /\/github\.com\/github\.com\//i;

/** De-double the first `…/github.com/github.com/…` segment in a path. */
export function canonicalGhqPath(doubledPath: string): string {
  return doubledPath.replace(DOUBLED_RE, "/github.com/");
}

/**
 * Check — repos cloned under a doubled `github.com/github.com/` path.
 *
 * @param repoPaths  full repo paths, e.g. the output of `ghq list --full-path`.
 * @param exists     filesystem probe for the canonical path (injectable; tests
 *                   pass a stub). Defaults to `existsSync`.
 */
export function checkDoubledGhqPaths(
  repoPaths: string[],
  exists: (path: string) => boolean = existsSync,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const seen = new Set<string>();
  for (const path of repoPaths) {
    if (!DOUBLED_RE.test(path) || seen.has(path)) continue;
    seen.add(path);
    const canonical = canonicalGhqPath(path);
    const canonicalExists = repoPaths.includes(canonical) || exists(canonical);
    findings.push({
      level: "warn",
      check: "doubled-ghq-path",
      fixable: false,
      message: canonicalExists
        ? `doubled ghq path '${path}' duplicates the canonical '${canonical}' (which exists) — ` +
          `after confirming no unpushed work, remove the doubled copy: rm -rf '${path}'`
        : `doubled ghq path '${path}' has no canonical copy — ` +
          `move it to the correct location: mv '${path}' '${canonical}'`,
      detail: { doubled: path, canonical, canonicalExists },
    });
  }
  return findings;
}
