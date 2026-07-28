import type { SignTier } from "./store";

/** One changed file in a PR diff — the shape `gh pr view --json files` returns per entry. */
export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface SignTierClassification {
  tiers: SignTier[];
  reason: string;
}

/**
 * kobo-546: sensitivity is decided by PATH ONLY (deterministic, greppable, one
 * list) — never by reading intent or diff content. "shared property" (lead's own
 * wording, use verbatim): a file other oracles run without deploying it
 * themselves — `~/.bun/bin/maw` symlinks into ONE checkout, so editing here hits
 * every oracle instantly, nobody presses anything. A file matching this
 * definition is sensitive, no further argument needed.
 *
 * 6 from the lead + 5 that proved themselves live the same day (kobo-335/362/
 * 400/501/546 dogfood). #1/#2 (hash, money) have no matching file in THIS repo
 * today — maw-js doesn't touch payment/hash-dedup code, that lives in sibling
 * repos (kob-payment-gateway etc, see the global hash-SACRED rule) — the entries
 * stay in the table for when/if such a path ever appears here.
 */
export const SENSITIVE_PATHS: Array<{ category: string; match: (path: string) => boolean }> = [
  { category: "hash / idempotency", match: (p) => /(^|\/)(hash|idempotency)(\/|[-.]|$)/i.test(p) },
  { category: "money paths", match: (p) => /(^|\/)(money|payment|billing)(\/|[-.]|$)/i.test(p) },
  // kobo-546 REWORK hole B (%109): mcp/tools.ts is a SECOND entry point into the
  // same sign/merge verbs — it builds the merge argv and can push --single-tier
  // (tools.ts:363) exactly like the CLI. Same gate, two doors, one category.
  { category: "sign/merge gate code itself", match: (p) => p === "src/core/tasks/store.ts" || p === "src/vendor/mpr-plugins/task/index.ts" || p === "src/core/tasks/sign-tier-classifier.ts" || p === "src/vendor/mpr-plugins/mcp/tools.ts" },
  { category: "TaskRecord schema", match: (p) => p === "src/core/tasks/store.ts" },
  { category: "crew-skills assets / hook-setup / statusline", match: (p) => p.startsWith("src/vendor/mpr-plugins/crew-skills/") || p === "src/core/worklog/hook-setup.ts" || p === "src/core/status-reporter.ts" },
  { category: "CI config", match: (p) => p.startsWith(".github/workflows/") },
  { category: "pr-watch", match: (p) => p === "src/core/worklog/pr-watch.ts" || p.startsWith("src/vendor-plugins/serve-pr-watch/") },
  // kobo-546 REWORK hole A (%109, the serious one): task/index.ts is only the
  // CALLER of --from auth — the actual trust root is authenticateActor at
  // src/commands/shared/comm-send.ts:259 (kobo-335: an unauthenticated --from
  // forges sign state). Both matched — the caller AND the root.
  { category: "resolve actor / sign auth", match: (p) => p === "src/vendor/mpr-plugins/task/index.ts" || p === "src/commands/shared/comm-send.ts" },
  { category: "teardown / kill helper", match: (p) => p === "src/vendor/mpr-plugins/crew/teardown.ts" },
  { category: "route.ts / board projection", match: (p) => p === "src/core/tasks/route.ts" },
  { category: "hook provisioning (~/.config/maw/hooks)", match: (p) => p === "src/core/worklog/hook-setup.ts" },
];

/**
 * kobo-546 REWORK — eq3 lead's STARTING number, not a proven one (his own words:
 * "adjustable with real data"). A diff over this many changed lines (additions +
 * deletions, summed across counted files, lockfiles/generated output excluded)
 * requires 2 tiers even with zero sensitive-path hits — a diff this large is hard
 * for one reviewer to actually hold in their head. This operationalizes rule 3's
 * "line count is necessary but not sufficient for the small bucket": necessary =
 * must be under this number, not sufficient = still loses to a sensitive-path
 * hit above regardless of size. Lives HERE, same file as SENSITIVE_PATHS, one
 * place per rule 4 — not a second scattered threshold.
 */
export const LARGE_DIFF_LINE_THRESHOLD = 300;

/**
 * Excluded from the line-count total: lockfiles (mechanical, nobody hand-reviews
 * a lockfile diff) and generated/bundled output (not hand-written, nothing to
 * review). Interpreted NARROWLY on purpose — this repo's OWN
 * `src/vendor/mpr-plugins/` convention is real hand-written plugin source and is
 * NOT excluded here; "vendored bundles" could also read as this repo's vendor/
 * naming, flagging that reading for override rather than silently widening the
 * exclusion to real source.
 */
function isExcludedFromLineCount(path: string): boolean {
  const LOCKFILES = new Set(["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
  const base = path.split("/").pop() ?? path;
  if (LOCKFILES.has(base)) return true;
  if (/\.(min|bundle)\.[jt]s$/.test(path)) return true;
  if (/(^|\/)(dist|generated)\//.test(path)) return true;
  return false;
}

/**
 * kobo-546 rule 6 (mechanical, no interpretation): a test file diff carrying ANY
 * deletion line (`-`) means someone touched an EXISTING assertion and this
 * classifier can't tell whether it got weaker — 2 tiers. A test file that is
 * pure addition (0 deletions) can be 1 tier.
 */
function isTestFile(path: string): boolean {
  return /\.test\.[jt]sx?$/.test(path) || /(^|\/)test\//.test(path);
}

/**
 * kobo-546 REWORK item 4 (%109): additions+deletions across the WHOLE PR (lockfiles/
 * generated excluded, `isExcludedFromLineCount`) — but `gh` reports 0 additions AND
 * 0 deletions for a binary or otherwise-unreadable file, so a large binary-heavy PR
 * could total UNDER the threshold and wrongly buy itself 1 tier. Any single
 * countable file reporting 0/0 makes the WHOLE total undeterminable → `null`, the
 * caller fail-closes. (A genuine mode-only/rename-only text diff would also trip
 * this — same safe direction, 2 tiers is never a false negative.)
 */
function totalCountableLines(files: DiffFile[]): number | null {
  let total = 0;
  for (const f of files) {
    if (isExcludedFromLineCount(f.path)) continue;
    if (f.additions === 0 && f.deletions === 0) return null;
    total += f.additions + f.deletions;
  }
  return total;
}

/**
 * Pure — no gh, no filesystem. `files === null` = diff unreadable (gh failed, no
 * PR linked, or the caller never had a diff to give it) — fail-closed 2 tiers.
 * `files.length === 0` = empty diff (PR with no changed files) — ALSO
 * fail-closed 2 tiers per the card's own unhappy path, not treated as harmless.
 */
export function classifySignTiers(files: DiffFile[] | null): SignTierClassification {
  if (files === null) return { tiers: ["crew", "head"], reason: "diff unreadable (gh failure / no PR to read) — fail-closed" };
  if (files.length === 0) return { tiers: ["crew", "head"], reason: "empty diff (PR has no changed files) — fail-closed" };

  // path-sensitivity wins over everything else, checked first (rule 3: path only).
  for (const f of files) {
    const hit = SENSITIVE_PATHS.find((s) => s.match(f.path));
    if (hit) return { tiers: ["crew", "head"], reason: `touches sensitive path (${hit.category}): ${f.path}` };
  }

  const total = totalCountableLines(files);
  if (total === null) {
    return { tiers: ["crew", "head"], reason: "at least one file reports 0 additions/0 deletions (binary or unreadable) — line count can't be determined, fail-closed" };
  }
  if (total > LARGE_DIFF_LINE_THRESHOLD) {
    return { tiers: ["crew", "head"], reason: `diff is ${total} changed lines (additions+deletions, lockfiles/generated excluded) — over the ${LARGE_DIFF_LINE_THRESHOLD}-line threshold` };
  }

  for (const f of files) {
    if (isTestFile(f.path) && f.deletions > 0) {
      return { tiers: ["crew", "head"], reason: `test file diff removes/edits existing lines, can't verify assertions weren't weakened: ${f.path}` };
    }
  }

  return { tiers: ["head"], reason: "no sensitive path, no test-file deletions" };
}
