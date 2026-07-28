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

  // kobo-101: a rejected card is terminal ("closed, not accepted"). If a PR linked
  // to it later merges, pr-watch must NOT resurrect it to done — the kobo-99
  // resurrection bug in a new guise. findTasksByPr excludes rejected exactly like
  // done, so the merged→done flip never reaches a rejected card.
  it("excludes a REJECTED card so a later PR merge can't resurrect it to done", async () => {
    const { findCardsByPrAnywhere } = await import("./pr-watch.ts?reject-noresurrect");
    card("kobo", "rejected-90", { state: "rejected", pr: 90, repo: "meganechan/maw-js" });
    card("kobo", "review-91", { state: "review", pr: 91, repo: "meganechan/maw-js" }); // live control
    expect(findCardsByPrAnywhere(90, "meganechan/maw-js")).toEqual([]); // rejected → never flipped
    expect(findCardsByPrAnywhere(91, "meganechan/maw-js").map((h) => h.taskId)).toEqual(["review-91"]);
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

// kobo-228: pr-watch is a single-fire snapshot transition-diff — the merge→done
// EDGE fires once. A server restart reseeds the snapshot (firstRun baselines the
// current MERGED state without acting), or a card is routed into review/approve
// AFTER the edge passed → the card strands until a manual `task done`. An approve
// card is most exposed (it waits on Tony). The reconcile pass closes that gap.
describe("reconcileMergedCards — swallowed merge-edge recovery (kobo-228)", () => {
  it("flips an APPROVE-lane card whose merge edge was swallowed (the reported bug)", async () => {
    const { reconcileMergedCards } = await import("./pr-watch.ts?recon-approve");
    const { readTask } = await import("../tasks/store.ts?recon-approve");
    card("kobo", "kobo-1", { state: "approve", pr: 50, repo: "meganechan/maw-js", assignee: "patchwork", reviewReason: "deploy blessing" });
    const flipped = reconcileMergedCards(50, "meganechan/maw-js", "pr-watch");
    expect(flipped).toEqual(["kobo-1"]);
    // kobo-274: a has-PR card is deploy-required by default → the merge parks it in
    // wait-for-deploy (merged≠live), not done; slice C drains it after the deploy.
    expect(readTask("kobo", "kobo-1")?.state).toBe("wait-for-deploy");
  });

  it("flips a REVIEW card too (no regress) and EVERY card the PR binds (kobo-43)", async () => {
    const { reconcileMergedCards } = await import("./pr-watch.ts?recon-multi");
    const { readTask } = await import("../tasks/store.ts?recon-multi");
    card("kobo", "kobo-2", { state: "review", pr: 51, repo: "meganechan/maw-js", assignee: "p" });
    card("kobo", "kobo-3", { state: "approve", pr: 51, repo: "meganechan/maw-js", assignee: "p", reviewReason: "why" });
    const flipped = reconcileMergedCards(51, "meganechan/maw-js", "pr-watch").sort();
    expect(flipped).toEqual(["kobo-2", "kobo-3"]);
    // kobo-274: has-PR default → park in wait-for-deploy (both cards).
    expect(readTask("kobo", "kobo-2")?.state).toBe("wait-for-deploy");
    expect(readTask("kobo", "kobo-3")?.state).toBe("wait-for-deploy");
  });

  it("is idempotent — a done/rejected card is never resurrected (kobo-99/101), no churn", async () => {
    const { reconcileMergedCards } = await import("./pr-watch.ts?recon-idem");
    const { readTask } = await import("../tasks/store.ts?recon-idem");
    card("kobo", "already", { state: "done", pr: 52, repo: "meganechan/maw-js" });
    card("kobo", "nope", { state: "rejected", pr: 52, repo: "meganechan/maw-js", rejectReason: "x" });
    const flipped = reconcileMergedCards(52, "meganechan/maw-js", "pr-watch");
    expect(flipped).toEqual([]); // nothing open → no-op
    expect(readTask("kobo", "already")?.state).toBe("done");
    expect(readTask("kobo", "nope")?.state).toBe("rejected"); // not resurrected
  });

  it("scopes by repo — a cross-repo PR# collision does not flip the wrong card (kobo-99)", async () => {
    const { reconcileMergedCards } = await import("./pr-watch.ts?recon-xrepo");
    const { readTask } = await import("../tasks/store.ts?recon-xrepo");
    card("kobo", "here", { state: "approve", pr: 5, repo: "kob-bank/helm", assignee: "p", reviewReason: "r" });
    card("kobo", "elsewhere", { state: "approve", pr: 5, repo: "kob-bank/report", assignee: "p", reviewReason: "r" });
    reconcileMergedCards(5, "kob-bank/helm", "pr-watch");
    expect(readTask("kobo", "here")?.state).toBe("wait-for-deploy"); // kobo-274: has-PR → park
    expect(readTask("kobo", "elsewhere")?.state).toBe("approve"); // untouched — different repo
  });

  it("a NON-deploy card (deployRequired:false) still reconciles straight to done (kobo-274 override)", async () => {
    const { reconcileMergedCards } = await import("./pr-watch.ts?recon-nodeploy");
    const { readTask } = await import("../tasks/store.ts?recon-nodeploy");
    card("kobo", "docs-1", { state: "review", pr: 53, repo: "meganechan/maw-js", assignee: "p", deployRequired: false });
    const flipped = reconcileMergedCards(53, "meganechan/maw-js", "pr-watch");
    expect(flipped).toEqual(["docs-1"]);
    expect(readTask("kobo", "docs-1")?.state).toBe("done"); // override → no park
  });

  it("parking is IDEMPOTENT — a second reconcile poll does NOT re-process a wait-for-deploy card (kobo-274)", async () => {
    const { reconcileMergedCards } = await import("./pr-watch.ts?recon-idem-park");
    const { readTask } = await import("../tasks/store.ts?recon-idem-park");
    card("kobo", "parked-1", { state: "review", pr: 54, repo: "meganechan/maw-js", assignee: "p" });
    const run1 = reconcileMergedCards(54, "meganechan/maw-js", "pr-watch");
    expect(run1).toEqual(["parked-1"]); // first poll parks it
    expect(readTask("kobo", "parked-1")?.state).toBe("wait-for-deploy");
    const stamp1 = readTask("kobo", "parked-1")!.updatedTs;
    const run2 = reconcileMergedCards(54, "meganechan/maw-js", "pr-watch");
    expect(run2).toEqual([]); // second poll must NOT re-flip — no churn/event spam
    expect(readTask("kobo", "parked-1")!.updatedTs).toBe(stamp1); // and no updatedTs bump
  });

  // kobo-507 — the real kobo-495 shape: a card sitting in review with a stale
  // pr link to a CLOSED (not merged) PR had no way out — findTasksByPr only
  // skips done/rejected/wait-for-deploy, not review. clearTaskPr closes it a
  // different way: the pr field itself is gone, so `t.pr === pr` is false
  // against EVERY pr number regardless of the card's state — reconcile can
  // never find it again, first pass or the hundredth. Per conductor's
  // instruction: any new skip-condition/state must prove itself idempotent
  // across TWO reconcile passes, not just one.
  it("kobo-507: a card whose PR was cleared (superseded) is invisible to reconcile forever, even sitting in review", async () => {
    const { reconcileMergedCards } = await import("./pr-watch.ts?recon-507");
    const { readTask, clearTaskPr } = await import("../tasks/store.ts?recon-507");
    card("kobo", "kobo-495", { state: "review", pr: 334, repo: "meganechan/maw-js", assignee: "patchwork", crewGate: true });

    const cleared = clearTaskPr("kobo", "kobo-495", "eq3", "PR #334 closed, superseded by kobo-504/kobo-506")!;
    expect(cleared.pr).toBeUndefined();
    expect(cleared.state).toBe("review"); // untouched by design — not clearTaskPr's call

    const run1 = reconcileMergedCards(334, "meganechan/maw-js", "pr-watch");
    expect(run1).toEqual([]); // never matched — the pr link is gone
    const run2 = reconcileMergedCards(334, "meganechan/maw-js", "pr-watch");
    expect(run2).toEqual([]); // second pass — still nothing, no thrash
    expect(readTask("kobo", "kobo-495")?.state).toBe("review"); // reconcile never touched it
  });
});

// kobo-594 — pollPrsOnce() shells to the real `gh` binary with no injectable
// fetcher (unlike task/index.ts's headShaFetcher/prDiffFetcher pattern), so its
// mergeable-state wiring can't be driven end-to-end in this test file. Content-
// assert companion, same convention as plugin-task-standalone.test.ts's `sign`
// pins: reads the real source and checks the SHAPE that matters, not just "the
// field exists somewhere" — placement relative to the firstRun/prev===cur
// early-returns is exactly what makes this either self-healing every poll or a
// dead write that only fires once per PR's lifetime (the bug this card exists
// to close).
import { readFileSync as readFileSyncPw } from "node:fs";
import { join as joinPw } from "node:path";

describe("pollPrsOnce — mergeable-state write is wired correctly (kobo-594)", () => {
  const src = readFileSyncPw(joinPw(import.meta.dir, "pr-watch.ts"), "utf8");

  it("gh pr list requests mergeable + mergeStateStatus — riding the SAME call, not a second gh invocation", () => {
    const listCallIdx = src.indexOf('"pr", "list"');
    expect(listCallIdx).toBeGreaterThan(-1);
    const listCallBlock = src.slice(listCallIdx, src.indexOf("]);", listCallIdx));
    expect(listCallBlock).toContain("mergeable");
    expect(listCallBlock).toContain("mergeStateStatus");
    // sanity: exactly one gh(["pr","list",...]) call in the whole poll loop —
    // if this ever becomes 2, the "zero extra gh calls" design claim is false.
    expect(src.match(/"pr",\s*"list"/g)?.length).toBe(1);
  });

  it("the mergeable write runs BEFORE firstRun/prev===cur early-returns — every poll, not just on a state transition", () => {
    const writeIdx = src.indexOf("setTaskPrMergeState(");
    const firstRunContinueIdx = src.indexOf("if (firstRun) continue;");
    const prevCurContinueIdx = src.indexOf("if (prev === cur) continue;");
    expect(writeIdx).toBeGreaterThan(-1);
    expect(firstRunContinueIdx).toBeGreaterThan(-1);
    expect(prevCurContinueIdx).toBeGreaterThan(-1);
    // if this ever flips (write moved AFTER either continue), the write only
    // fires on a PR's own open/merge/close edge — an OPEN PR that stays OPEN
    // while a SIBLING PR flips it conflicting would never update again.
    expect(writeIdx).toBeLessThan(firstRunContinueIdx);
    expect(writeIdx).toBeLessThan(prevCurContinueIdx);
  });

  it("the write is gated on cur === \"OPEN\" and truthy pr.mergeable/mergeStateStatus — never fires on a failed/rate-limited gh call", () => {
    const writeIdx = src.indexOf("setTaskPrMergeState(");
    // walk back to the nearest enclosing `if (...)` guard immediately above the write
    const guardStart = src.lastIndexOf("if (cur ===", writeIdx);
    expect(guardStart).toBeGreaterThan(-1);
    const guardLine = src.slice(guardStart, src.indexOf(")", src.indexOf("{", guardStart)));
    expect(guardLine).toContain('cur === "OPEN"');
    expect(guardLine).toContain("pr.mergeable");
    expect(guardLine).toContain("pr.mergeStateStatus");
  });
});
