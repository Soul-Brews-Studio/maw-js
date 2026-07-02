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
import { completeTask, findTaskByPr, prOpenedReview } from "../tasks/store";
import { pingOnMerge } from "./ping";
import { scopeOfOracle, companyOfOracle } from "./company-scope";
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

/** One poll pass over the fleet's repos. Returns the entries recorded. */
export async function pollPrsOnce(): Promise<WorklogEntry[]> {
  const cfg = loadConfig() as any;
  const fallbackCompany: string | undefined = cfg.company;

  let repos: string[];
  try {
    const wts = await scanWorktrees();
    repos = [...new Set(wts.map(w => w.mainRepo).filter(Boolean))];
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

      if (firstRun) continue; // seed baseline only — no retroactive spam
      if (prev === cur) continue;

      const company = (author ? companyOfOracle(author) : null) ?? fallbackCompany;
      const base = { ts: Date.now(), iso: new Date().toISOString(), oracle: author || "unknown", company, repo, pr: pr.number };

      if (cur === "MERGED") {
        const by = await mergedBy(repo, pr.number);
        const entry: WorklogEntry = { ...base, kind: "pr-merged", summary: `merged #${pr.number} ${pr.title}`, by };
        record(entry);
        recorded.push(entry);
        const lead = author ? scopeOfOracle(author)?.lead ?? null : null;
        pingOnMerge({ lead, author: author ?? null, pr: pr.number, repo, by });
        // Track 4 — merge = approval → auto-done the task that owns this PR.
        try {
          const task = company ? findTaskByPr(company, pr.number) : null;
          if (task) completeTask(company, task.id, by || author || "pr-watch");
        } catch { /* never let task auto-done break PR-watch */ }
      } else if (cur === "CLOSED") {
        const entry: WorklogEntry = { ...base, kind: "pr-closed", summary: `closed #${pr.number} ${pr.title}` };
        record(entry);
        recorded.push(entry);
      } else if (cur === "OPEN" && prev == null) {
        const entry: WorklogEntry = { ...base, kind: "pr-opened", summary: `opened #${pr.number} ${pr.title}` };
        record(entry);
        recorded.push(entry);
        // eq3-011 kobo-13: PR open = truth → drive the linked card to review,
        // owned by the PR author, reviewer = human. Mirrors the merge→done path;
        // acts off the card.pr link, fires once on this OPEN transition.
        try {
          const task = company && author ? findTaskByPr(company, pr.number) : null;
          if (task && author) prOpenedReview(company, task.id, author);
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
