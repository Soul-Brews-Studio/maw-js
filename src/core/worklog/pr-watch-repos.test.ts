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
