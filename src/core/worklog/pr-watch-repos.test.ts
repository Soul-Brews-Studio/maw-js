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

// kobo-99: a PR number is unique only WITHIN a repo. Merged owner/a#5 previously
// flipped a card bound to owner/b#5 to done while it was still OPEN — board lied
// across repos. When pr-watch scopes the lookup to the merged repo, only the
// matching card is returned; the sibling in another repo is untouched.
describe("findCardsByPrAnywhere scoped by repo (kobo-99 cross-repo collision)", () => {
  it("matches only the card in the merged repo, never a same-number card in another repo", async () => {
    const { findCardsByPrAnywhere } = await import("./pr-watch.ts?xrepo-scope");
    card("kobo", "report-5", { state: "review", pr: 5, repo: "kob-bank/report-service" });
    card("kobo", "helm-5", { state: "review", pr: 5, repo: "kob-bank/helm-charts" }); // still open, other repo

    // merge of report-service#5 must flip ONLY report-5, not helm-5
    expect(findCardsByPrAnywhere(5, "kob-bank/report-service").map((h) => h.taskId)).toEqual(["report-5"]);
    expect(findCardsByPrAnywhere(5, "kob-bank/helm-charts").map((h) => h.taskId)).toEqual(["helm-5"]);
  });

  it("still finds a repo-less card by number alone (kobo-80 heal path preserved)", async () => {
    const { findCardsByPrAnywhere } = await import("./pr-watch.ts?xrepo-repoless");
    card("kobo", "no-repo", { state: "review", pr: 7 }); // no repo → heal backfills on flip
    // a repo-less card has no repo to conflict, so any repo's poll still surfaces it
    expect(findCardsByPrAnywhere(7, "kob-bank/anything").map((h) => h.taskId)).toEqual(["no-repo"]);
  });

  it("without a repo arg, matches by number alone (unchanged legacy behavior)", async () => {
    const { findCardsByPrAnywhere } = await import("./pr-watch.ts?xrepo-norepoarg");
    card("kobo", "a-5", { state: "review", pr: 5, repo: "kob-bank/report-service" });
    card("kobo", "b-5", { state: "review", pr: 5, repo: "kob-bank/helm-charts" });
    expect(findCardsByPrAnywhere(5).map((h) => h.taskId).sort()).toEqual(["a-5", "b-5"]);
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

// kobo-80: a repo-less pr card is INVISIBLE to openPrLinkedRepos → its merge is
// never polled → it strands in review (the kobo-71/38 hand-flip). The heal: when a
// poll DOES surface the PR (via a worktree/sibling repo) it backfills the card's
// repo, so from then on openPrLinkedRepos includes it and the flip is guaranteed.
describe("repo-less card heal (kobo-80)", () => {
  it("setTaskRepoIfMissing makes a repo-less pr card discoverable, without overwriting", async () => {
    const { openPrLinkedRepos } = await import("./pr-watch.ts?heal-discover");
    const { setTaskRepoIfMissing, readTask } = await import("../tasks/store.ts?heal-discover");
    card("kobo", "kobo-71", { state: "review", pr: 71 });                       // no repo → invisible
    card("kobo", "kobo-9", { state: "review", pr: 9, repo: "acme/keep" });      // repo set already
    expect(openPrLinkedRepos()).toEqual(["acme/keep"]);                         // kobo-71 absent (ROOT)

    setTaskRepoIfMissing("kobo", "kobo-71", "meganechan/maw-js");               // pr-watch heal
    setTaskRepoIfMissing("kobo", "kobo-9", "other/nope");                       // must NOT clobber
    expect(readTask("kobo", "kobo-71")?.repo).toBe("meganechan/maw-js");
    expect(readTask("kobo", "kobo-9")?.repo).toBe("acme/keep");                 // unchanged
    expect(openPrLinkedRepos().sort()).toEqual(["acme/keep", "meganechan/maw-js"]);
  });

  it("merge → done flips a repo-less card AND backfills its repo (the exact pr-watch sequence)", async () => {
    const { findCardsByPrAnywhere } = await import("./pr-watch.ts?heal-flip");
    const { completeTask, setTaskRepoIfMissing, readTask } = await import("../tasks/store.ts?heal-flip");
    card("kobo", "kobo-71", { state: "review", pr: 71, assignee: "patchwork" }); // no repo

    // what pollPrsOnce runs on a MERGED transition once the PR is seen in `repo`:
    for (const hit of findCardsByPrAnywhere(71)) {
      setTaskRepoIfMissing(hit.company, hit.taskId, "meganechan/maw-js");
      completeTask(hit.company, hit.taskId, "pr-watch");
    }
    expect(readTask("kobo", "kobo-71")?.state).toBe("done");                    // no hand-flip
    expect(readTask("kobo", "kobo-71")?.repo).toBe("meganechan/maw-js");        // healed for next time
  });
});
