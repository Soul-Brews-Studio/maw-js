/**
 * BL-226 — worktree tombstone (borrowed idea from herdr-tree/Nat, research note
 * ψ/research/2026-10-09_herdr-vs-maw.md §4.1): before `maw done` / `maw cleanup
 * --worktrees` removes a worktree, write a durable markdown record to
 * `<mainPath>/ψ/memory/tombstones/<YYYY-MM-DD>_<slug>.md` so nothing vanishes
 * silently, and compute a BLOCKER verdict (uncommitted or not-merged) so a
 * dry-run reports it and does NOT exit 0 while the removal is unsafe — fixing
 * the "exit 0 is only a claim" gap the research note calls out.
 *
 * Pure + dependency-injected: no direct fs/exec at import time, so it is unit
 * testable without a live repo or filesystem.
 */

export interface WorktreeFactsInput {
  /** The main (non-worktree) repo checkout that owns the worktree. */
  mainPath: string;
  /** The worktree path being removed. */
  wtPath: string;
  /** The worktree's current branch (abbrev); "" / "HEAD" tolerated. */
  branch: string;
  /** Base branch to test "merged into" against (e.g. "main" | "alpha"). */
  baseBranch: string;
}

export interface WorktreeFacts extends WorktreeFactsInput {
  head: string; // short sha, or "unknown"
  uncommittedFiles: string[]; // paths with uncommitted/untracked changes (porcelain)
  mergedIntoBase: "yes" | "no" | "unknown";
}

export interface TombstoneDeps {
  /** Run a shell command, return stdout. */
  exec?: (cmd: string) => Promise<string>;
  /** Write a file (mkdir -p handled by caller or here via exec). */
  writeFile?: (path: string, content: string) => Promise<void>;
  /** Current time (for the ceased timestamp + date-stamped filename). */
  now?: () => Date;
  log?: (msg: string) => void;
}

function sh(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Collect the facts a tombstone records, read-only against git. Never throws. */
export async function collectWorktreeFacts(
  input: WorktreeFactsInput,
  deps: TombstoneDeps = {},
): Promise<WorktreeFacts> {
  const exec = deps.exec ?? (async () => "");
  const { mainPath, wtPath, branch, baseBranch } = input;

  let head = "unknown";
  try {
    const out = (await exec(`git -C ${sh(wtPath)} rev-parse --short HEAD`)).trim();
    if (out) head = out;
  } catch { /* leave unknown */ }

  let uncommittedFiles: string[] = [];
  try {
    const out = (await exec(`git -C ${sh(wtPath)} status --porcelain`)).trim();
    uncommittedFiles = out ? out.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  } catch { /* leave empty; absence of proof is not proof of clean — see mergedIntoBase */ }

  let mergedIntoBase: WorktreeFacts["mergedIntoBase"] = "unknown";
  if (branch && branch !== "HEAD" && baseBranch) {
    try {
      // exit 0 ⇒ branch is an ancestor of base ⇒ merged
      await exec(`git -C ${sh(mainPath)} merge-base --is-ancestor ${sh(branch)} ${sh(baseBranch)}`);
      mergedIntoBase = "yes";
    } catch (e) {
      // merge-base --is-ancestor exits 1 for "not an ancestor" (a real "no"), but
      // 128 / a fatal for a bad/missing ref or non-repo — which we must NOT report
      // as "no". Classify by the error text; anything that looks like a git fault
      // stays "unknown" (and unknown is fail-closed = a blocker downstream).
      const msg = e instanceof Error ? e.message : String(e);
      mergedIntoBase = /fatal|not a git|bad revision|unknown revision|usage:/i.test(msg) ? "unknown" : "no";
    }
  }

  return { mainPath, wtPath, branch, baseBranch, head, uncommittedFiles, mergedIntoBase };
}

export interface TombstoneBlocker {
  blocked: boolean;
  reasons: string[]; // human-readable blocker reasons; empty when not blocked
}

/**
 * A removal is BLOCKED (unsafe without --force) when the worktree has
 * uncommitted/untracked changes, or its branch is not merged into base.
 * "unknown" merge status is treated as a blocker (fail-closed): we must not
 * report a clean removal we could not prove safe.
 */
export function tombstoneBlocker(facts: WorktreeFacts): TombstoneBlocker {
  const reasons: string[] = [];
  if (facts.uncommittedFiles.length > 0) {
    reasons.push(`${facts.uncommittedFiles.length} uncommitted/untracked file(s) would be lost`);
  }
  if (facts.mergedIntoBase === "no") {
    reasons.push(`branch '${facts.branch}' is not merged into ${facts.baseBranch}`);
  } else if (facts.mergedIntoBase === "unknown") {
    reasons.push(`merge status into ${facts.baseBranch} could not be verified`);
  }
  return { blocked: reasons.length > 0, reasons };
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }
function dateStamp(d: Date): string { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

/** Render the tombstone markdown (frontmatter + body). Pure. */
export function renderTombstone(
  facts: WorktreeFacts,
  meta: { slug: string; reason?: string; successor?: string; born?: string; now?: Date } = { slug: "" },
): string {
  const now = meta.now ?? new Date();
  const blocker = tombstoneBlocker(facts);
  const fm = [
    "---",
    `slug: ${meta.slug}`,
    `repo: ${facts.mainPath}`,
    `worktree: ${facts.wtPath}`,
    `branch: ${facts.branch || "(detached)"}`,
    `head: ${facts.head}`,
    `base: ${facts.baseBranch}`,
    `born: ${meta.born ?? "unknown"}`,
    `ceased: ${now.toISOString()}`,
    `reason: ${meta.reason ?? "worktree removed"}`,
    `successor: ${meta.successor ?? "none"}`,
    `merged_into_base: ${facts.mergedIntoBase}`,
    `blocked: ${blocker.blocked}`,
    "---",
  ].join("\n");

  const body: string[] = [
    "",
    `# tombstone — ${meta.slug}`,
    "",
    `- HEAD (${facts.head}) contained in ${facts.baseBranch}: **${facts.mergedIntoBase}**`,
  ];
  if (blocker.blocked) {
    body.push("", "## ⚠ BLOCKER (removal unsafe without --force)");
    for (const r of blocker.reasons) body.push(`- ${r}`);
  }
  if (facts.uncommittedFiles.length > 0) {
    body.push("", "## Not committed at the time (files that will be lost)");
    for (const f of facts.uncommittedFiles) body.push(`- \`${f}\``);
  } else {
    body.push("", "_No uncommitted changes recorded._");
  }
  body.push("");
  return `${fm}\n${body.join("\n")}`;
}

export interface TombstoneResult {
  path: string;
  blocker: TombstoneBlocker;
  wrote: boolean;
}

/**
 * Collect facts, write the tombstone record under <mainPath>/ψ/memory/tombstones/,
 * and return the blocker verdict. The record is written whenever possible (even
 * on a blocker) so the evidence survives; the caller decides whether to proceed
 * with removal based on `result.blocker` + its own --force flag.
 */
export async function recordTombstone(
  input: WorktreeFactsInput,
  meta: { slug: string; reason?: string; successor?: string; born?: string; dryRun?: boolean },
  deps: TombstoneDeps = {},
): Promise<TombstoneResult> {
  const exec = deps.exec ?? (async () => "");
  const log = deps.log ?? (() => {});
  const now = (deps.now ?? (() => new Date()))();

  const facts = await collectWorktreeFacts(input, deps);
  const blocker = tombstoneBlocker(facts);
  const md = renderTombstone(facts, { ...meta, now });

  const dir = `${input.mainPath}/ψ/memory/tombstones`;
  const path = `${dir}/${dateStamp(now)}_${meta.slug}.md`;

  // Dry-run is strictly read-only: collect facts + blocker + the path that WOULD be
  // written, but perform NO filesystem mutation (no mkdir, no write). This preserves
  // the "dry-run has no side effects" contract the done command promises.
  if (meta.dryRun) {
    log(`[dry-run] would write tombstone: ${path}`);
    return { path, blocker, wrote: false };
  }

  let wrote = false;
  try {
    if (deps.writeFile) {
      await exec(`mkdir -p ${sh(dir)}`).catch(() => {});
      await deps.writeFile(path, md);
      wrote = true;
    } else {
      // No writeFile injected: callers that want the record on disk must inject one.
      // We do NOT mkdir here (avoid a side effect that never gets a file).
      log(`tombstone not written (no writer injected): ${path}`);
    }
    if (wrote) log(`tombstone written: ${path}`);
  } catch (e) {
    log(`tombstone write failed: ${e instanceof Error ? e.message : String(e)}`);
    wrote = false;
  }
  return { path, blocker, wrote };
}
