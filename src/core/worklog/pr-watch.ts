/**
 * PR watcher — poll-based (snapshot diff, each transition logs once).
 *
 * Triggered by: `maw done` (on-signal), `maw company worklog log` (on-read),
 * `maw company worklog sync`, AND — on a running server — the `serve-pr-watch`
 * plugin's periodic tick (kobo-33), so a plain github.com web-merge drives the
 * linked card to done with NO human `maw` command.
 * `gh pr list` is ground truth for open/merged/closed; we diff against a snapshot
 * so each transition logs exactly once. On merge we ping the author's dept lead +
 * the author (carrying content), so the log gets read.
 *
 * An out-of-band github.com web merge is picked up within one server tick (or on
 * the next on-demand trigger when no server runs). In-pane `gh pr merge` is
 * caught immediately by the PostToolUse hook.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { mawStatePath } from "../xdg";
import { scanWorktrees } from "../fleet/worktrees";
import { loadConfig } from "../../config";
import { appendWorklog } from "./store";
import { completeTask, findTasksByPr, prOpenedReview, setTaskRepoIfMissing, listTasks, listCompanies } from "../tasks/store";
import { notifyReviewer } from "../tasks/notify";
import { pingOnMerge } from "./ping";
import { scopeOfOracle, companyOfOracleStrict } from "./company-scope";
import type { WorklogEntry } from "./types";

type PrState = "OPEN" | "MERGED" | "CLOSED";

interface SnapEntry { state: PrState; repo: string; number: number; title: string; author?: string }
type PrSnapshot = Record<string, SnapEntry>; // key = `${repo}#${number}`

interface GhPr {
  number: number;
  title: string;
  state: string;
  mergedAt: string | null;
  author?: { login?: string };
}

function snapshotPath(): string {
  return mawStatePath("watch-pr-state.json");
}

function loadSnapshot(): { snap: PrSnapshot; firstRun: boolean } {
  const p = snapshotPath();
  if (!existsSync(p)) return { snap: {}, firstRun: true };
  try {
    return { snap: JSON.parse(readFileSync(p, "utf-8")) as PrSnapshot, firstRun: false };
  } catch {
    return { snap: {}, firstRun: false };
  }
}

function saveSnapshot(snap: PrSnapshot): void {
  const p = snapshotPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(snap, null, 2) + "\n");
}

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh exited ${code}`);
  return out;
}

function prStateOf(pr: GhPr): PrState {
  if (pr.mergedAt) return "MERGED";
  return pr.state === "CLOSED" ? "CLOSED" : "OPEN";
}

/** Best-effort: forward to the live feed (browsers). Never throws. */
function postLive(entry: WorklogEntry): void {
  const port = process.env.MAW_PORT || "3456";
  fetch(`http://localhost:${port}/api/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      oracle: entry.oracle, event: "Notification", project: entry.repo ?? "", host: "local",
      message: entry.summary, ts: entry.ts,
      data: { kind: entry.kind, pr: entry.pr, repo: entry.repo, by: entry.by, summary: entry.summary },
    }),
  }).catch(() => {});
}

function record(entry: WorklogEntry): void {
  appendWorklog(entry);
  postLive(entry);
}

async function mergedBy(repo: string, num: number): Promise<string | undefined> {
  try {
    const out = await gh(["pr", "view", String(num), "--repo", repo, "--json", "mergedBy"]);
    return JSON.parse(out || "{}")?.mergedBy?.login || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Repos referenced by open (non-done) PR-linked cards, across every company on
 * this machine. The board's card→PR link is the source of truth for which repos
 * matter, independent of what worktrees/fleet windows happen to exist locally.
 */
export function openPrLinkedRepos(): string[] {
  return listCompanies().flatMap(company =>
    listTasks(company)
      .filter(t => typeof t.pr === "number" && t.state !== "done" && Boolean(t.repo))
      .map(t => t.repo as string),
  );
}

/**
 * Locate EVERY card linked to a PR across every company on this machine. The
 * card→PR link (task.pr) is globally unique per (company, card) but a single PR
 * can bind SEVERAL cards (kobo-43: PR #85 = kobo-38 + kobo-42) — so return all,
 * not the first, or merge→done strands every card past the first. Deliberately
 * does NOT map the PR author to a company: a github merge login often maps to
 * none, which previously stranded the flip.
 */
export function findCardsByPrAnywhere(pr: number, repo?: string): { company: string; taskId: string }[] {
  const hits: { company: string; taskId: string }[] = [];
  for (const company of listCompanies()) {
    for (const task of findTasksByPr(company, pr, repo)) hits.push({ company, taskId: task.id });
  }
  return hits;
}

export function findCardByPrAnywhere(pr: number, repo?: string): { company: string; taskId: string } | null {
  return findCardsByPrAnywhere(pr, repo)[0] ?? null;
}

/**
 * Merge = approval → done EVERY card this PR binds (kobo-43), idempotently. This
 * is the single flip primitive shared by (a) the OPEN→MERGED transition and (b)
 * the kobo-228 reconcile pass. Idempotent by construction: findTasksByPr already
 * excludes done+rejected, so a re-run flips nothing that's already closed (no
 * resurrection — kobo-99/101). Heals a repo-less card on the way (kobo-80). Returns
 * the ids it actually flipped (empty = everything already closed → no churn).
 *
 * kobo-228: pr-watch is a single-fire snapshot transition-diff — the merge→done
 * flip only fires on the OPEN→MERGED edge. That edge is SWALLOWED when the snapshot
 * is reseeded across a server restart (firstRun baselines the current MERGED state
 * without acting) or when a card is linked/routed into review/approve AFTER the edge
 * already passed. An approve-lane card is the most exposed: it waits on a human gate,
 * so a reseed easily lands between merge and blessing → the card strands until a
 * manual `task done`. Calling this on EVERY poll for a MERGED pr closes that gap.
 */
export function reconcileMergedCards(pr: number, repo: string, by: string): string[] {
  const flipped: string[] = [];
  for (const hit of findCardsByPrAnywhere(pr, repo)) {
    setTaskRepoIfMissing(hit.company, hit.taskId, repo); // kobo-80: heal repo-less card
    if (completeTask(hit.company, hit.taskId, by)) flipped.push(hit.taskId);
  }
  return flipped;
}

/** One poll pass over the fleet's repos. Returns the entries recorded. */
export async function pollPrsOnce(): Promise<WorklogEntry[]> {
  const cfg = loadConfig() as any;
  const fallbackCompany: string | undefined = cfg.company;

  // Repos to poll = local worktree repos ∪ repos referenced by open PR-linked
  // cards. Worktree scan alone misses a repo whose PRs drive the board when no
  // .wt-*/agents worktree or fleet window exists for it on this host (e.g. a
  // served maw-server on a box that only has its own repo checked out) — the
  // card→PR link is the board's own source of truth, so poll exactly what the
  // board points at. Generic on task.repo (any company/repo), never hardcoded.
  let repos: string[];
  try {
    const wts = await scanWorktrees();
    const worktreeRepos = wts.map(w => w.mainRepo).filter(Boolean);
    repos = [...new Set([...worktreeRepos, ...openPrLinkedRepos()])];
  } catch {
    return [];
  }
  if (!repos.length) return [];

  const { snap, firstRun } = loadSnapshot();
  const recorded: WorklogEntry[] = [];

  for (const repo of repos) {
    let prs: GhPr[];
    try {
      const out = await gh([
        "pr", "list", "--repo", repo, "--state", "all", "--limit", "30",
        "--json", "number,title,state,mergedAt,author",
      ]);
      prs = JSON.parse(out || "[]") as GhPr[];
    } catch {
      continue;
    }

    for (const pr of prs) {
      const key = `${repo}#${pr.number}`;
      const cur = prStateOf(pr);
      const prev = snap[key]?.state;
      const author = pr.author?.login;
      snap[key] = { state: cur, repo, number: pr.number, title: pr.title, author };

      // kobo-228 reconcile pass — a MERGED pr must leave NO linked card behind, even
      // when the merge→done EDGE was swallowed: a restart reseeds the snapshot
      // (firstRun baselines the current MERGED state without acting), or a card was
      // linked/routed into review/approve AFTER the edge already passed. Run it
      // exactly when the transition handler below WON'T (firstRun or no state change)
      // so a fresh OPEN→MERGED edge stays the transition handler's job (worklog +
      // ping + merger-resolved `by`). Idempotent: reconcileMergedCards flips only
      // still-open cards (done/rejected excluded) → no churn, no double-flip, no spam.
      if (cur === "MERGED" && (firstRun || prev === cur)) {
        try { reconcileMergedCards(pr.number, repo, author || "pr-watch"); }
        catch { /* never let task auto-done break PR-watch */ }
      }

      if (firstRun) continue; // seed baseline only — no retroactive spam
      if (prev === cur) continue;

      // The card→PR link is globally unique, so locate the card by PR number
      // across ALL companies rather than mapping the PR author to a company: a
      // github web-merge's author is the merging login (often a bot/human that
      // belongs to no company), which stranded the merge→done flip in _unscoped
      // and never reached the card (kobo-33 e2e). Prefer the card's own company
      // for the worklog entry too, so the event lands on that board's timeline.
      // Scope the card lookup to THIS repo — a PR number is unique only within a
      // repo, so merged owner/a#5 must not flip a card bound to owner/b#5 (kobo-99).
      const cardHits = findCardsByPrAnywhere(pr.number, repo);
      // kobo-216 — resolve the author's company via the STRICT resolver: no silent
      // first-match (the AC gap). This is a background daemon with no --company to
      // supply, so an ambiguous (multi-company) author can't be prompted — catch the
      // throw and fall to the configured fallbackCompany rather than aborting the whole
      // poll cycle (matches this file's "never let X break PR-watch" contract). The
      // primary path (cardHits[0].company) is unaffected; a single-company author
      // resolves byte-for-byte as before, so no worklog entry shifts company.
      let authorCompany: string | null = null;
      if (author) {
        try { authorCompany = companyOfOracleStrict(author); }
        catch { authorCompany = null; } // ambiguous → fallbackCompany, never guess a board
      }
      const company = cardHits[0]?.company ?? authorCompany ?? fallbackCompany;
      const base = { ts: Date.now(), iso: new Date().toISOString(), oracle: author || "unknown", company, repo, pr: pr.number };

      if (cur === "MERGED") {
        const by = await mergedBy(repo, pr.number);
        const entry: WorklogEntry = { ...base, kind: "pr-merged", summary: `merged #${pr.number} ${pr.title}`, by };
        record(entry);
        recorded.push(entry);
        const lead = author ? scopeOfOracle(author)?.lead ?? null : null;
        pingOnMerge({ lead, author: author ?? null, pr: pr.number, repo, by });
        // Track 4 — merge = approval → auto-done EVERY card that owns this PR
        // (kobo-43: one PR can bind several cards; flip them all, not just the
        // first, or the rest strand in review until a human hand-flips). Shares the
        // idempotent flip primitive with the kobo-228 reconcile pass — merger `by`
        // resolved here (fresh edge); a re-poll's reconcile no-ops (card already done).
        try { reconcileMergedCards(pr.number, repo, by || author || "pr-watch"); }
        catch { /* never let task auto-done break PR-watch */ }
      } else if (cur === "CLOSED") {
        const entry: WorklogEntry = { ...base, kind: "pr-closed", summary: `closed #${pr.number} ${pr.title}` };
        record(entry);
        recorded.push(entry);
      } else if (cur === "OPEN" && prev == null) {
        const entry: WorklogEntry = { ...base, kind: "pr-opened", summary: `opened #${pr.number} ${pr.title}` };
        record(entry);
        recorded.push(entry);
        // eq3-011 kobo-13: PR open = truth → drive the linked card(s) to review,
        // reviewer resolved via the chain. kobo-217: the doer (assignee) is KEPT —
        // the shared-github PR author is never stamped as owner (Board Truth rule 9).
        // Mirrors the merge→done path; acts off the card.pr link, fires once on this
        // OPEN transition. kobo-43: flip every card the PR binds, not just the first.
        try {
          if (author) for (const hit of cardHits) {
            setTaskRepoIfMissing(hit.company, hit.taskId, repo); // kobo-80: bind repo on the open→review flip → merge poll is guaranteed later
            const reviewed = prOpenedReview(hit.company, hit.taskId, author);
            if (reviewed) notifyReviewer(reviewed, author); // kobo-144: poke the resolved reviewer that a PR is up
          }
        } catch { /* never let task lifecycle break PR-watch */ }
      }
    }
  }

  saveSnapshot(snap);
  return recorded;
}

/** Fire-and-forget single poll (used by `maw done`). Never throws. */
export function triggerPrPollNow(): Promise<WorklogEntry[]> {
  return pollPrsOnce().catch(() => []);
}
