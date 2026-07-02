/**
 * openPrLinkedRepos — the board-driven repo discovery that lets pr-watch poll a
 * repo whose PRs drive cards even when no local worktree/fleet-window exists for
 * it (kobo-33 e2e gap). Hermetic: temp MAW_DATA_DIR, no gh / no worktree scan.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ORIG = process.env.MAW_DATA_DIR;
let root: string;

function card(company: string, id: string, fields: Record<string, unknown>): void {
  const dir = join(root, "companies", company, "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, company, title: id, ts: 1, ...fields }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "maw-prwatch-repos-"));
  process.env.MAW_DATA_DIR = root;
});

afterEach(() => {
  if (ORIG === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = ORIG;
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

describe("openPrLinkedRepos", () => {
  it("collects repos from open PR-linked cards across companies, deduped by caller", async () => {
    const { openPrLinkedRepos } = await import("./pr-watch.ts?repos-open");
    card("kobo", "kobo-33", { state: "review", pr: 77, repo: "meganechan/maw-js" });
    card("kobo", "kobo-34", { state: "review", pr: 80, repo: "meganechan/maw-js" });
    card("pgw", "pgw-1", { state: "in-progress", pr: 5, repo: "acme/pgw" });

    const repos = openPrLinkedRepos();
    expect(repos).toContain("meganechan/maw-js");
    expect(repos).toContain("acme/pgw"); // not hardcoded to maw-js — any repo
  });

  it("excludes done cards, cards without a pr, and cards without a repo", async () => {
    const { openPrLinkedRepos } = await import("./pr-watch.ts?repos-filters");
    card("kobo", "done-card", { state: "done", pr: 1, repo: "x/done" });
    card("kobo", "no-pr", { state: "review", repo: "x/nopr" });
    card("kobo", "no-repo", { state: "review", pr: 2 });
    card("kobo", "keep", { state: "review", pr: 3, repo: "x/keep" });

    const repos = openPrLinkedRepos();
    expect(repos).toEqual(["x/keep"]);
  });

  it("returns [] when no company home exists", async () => {
    const { openPrLinkedRepos } = await import("./pr-watch.ts?repos-empty");
    expect(openPrLinkedRepos()).toEqual([]);
  });
});

describe("findCardByPrAnywhere", () => {
  it("finds the card by PR across companies, independent of PR author", async () => {
    const { findCardByPrAnywhere } = await import("./pr-watch.ts?findcard-hit");
    card("kobo", "kobo-34", { state: "review", pr: 80, repo: "meganechan/maw-js" });
    card("pgw", "pgw-9", { state: "in-progress", pr: 5, repo: "acme/pgw" });

    expect(findCardByPrAnywhere(80)).toEqual({ company: "kobo", taskId: "kobo-34" });
    expect(findCardByPrAnywhere(5)).toEqual({ company: "pgw", taskId: "pgw-9" });
  });

  it("ignores done cards and returns null when no card owns the PR", async () => {
    const { findCardByPrAnywhere } = await import("./pr-watch.ts?findcard-miss");
    card("kobo", "done-card", { state: "done", pr: 80, repo: "x/y" });
    expect(findCardByPrAnywhere(80)).toBeNull(); // done cards excluded (findTaskByPr)
    expect(findCardByPrAnywhere(999)).toBeNull();
  });
});

// kobo-43: one PR can bind SEVERAL cards (PR #85 = kobo-38 + kobo-42). The old
// single-card finder + single completeTask flipped only the first, stranding the
// rest in review until a human hand-flipped. This is the gap single-card tests
// green-washed.
describe("findCardsByPrAnywhere + merge→done (kobo-43 multi-card)", () => {
  it("returns EVERY non-done card bound to one PR, excluding already-done", async () => {
    const { findCardsByPrAnywhere } = await import("./pr-watch.ts?findcards-multi");
    card("kobo", "kobo-38", { state: "review", pr: 85, repo: "meganechan/maw-js" });
    card("kobo", "kobo-42", { state: "review", pr: 85, repo: "meganechan/maw-js" });
    card("kobo", "kobo-99", { state: "review", pr: 90, repo: "meganechan/maw-js" }); // other PR
    card("kobo", "done-85", { state: "done", pr: 85, repo: "meganechan/maw-js" });   // already done

    const hits = findCardsByPrAnywhere(85);
    expect(hits.map((h) => h.taskId).sort()).toEqual(["kobo-38", "kobo-42"]);
  });

  it("merge → done flips ALL cards bound to the PR, none stranded", async () => {
    const { findCardsByPrAnywhere } = await import("./pr-watch.ts?flip-multi");
    const { completeTask, readTask } = await import("../tasks/store.ts?flip-multi");
    card("kobo", "kobo-38", { state: "review", pr: 85, repo: "meganechan/maw-js", assignee: "patchwork" });
    card("kobo", "kobo-42", { state: "review", pr: 85, repo: "meganechan/maw-js", assignee: "patchwork" });

    // the exact action pr-watch runs on a MERGED transition — no human, no gh.
    for (const hit of findCardsByPrAnywhere(85)) completeTask(hit.company, hit.taskId, "pr-watch");

    expect(readTask("kobo", "kobo-38")?.state).toBe("done");
    expect(readTask("kobo", "kobo-42")?.state).toBe("done"); // was stranded pre-fix
  });
});
