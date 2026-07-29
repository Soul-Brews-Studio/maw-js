import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runTask, sameTmuxSession } from "../../src/vendor/mpr-plugins/task/index";
import { addTask, isSelfReview, isSelfReviewPaneAware, parseReviewTarget, readTask, resolveReviewer } from "../../src/core/tasks/store";

// kobo-587: a crew cell shares ONE oracle name across MANY tmux panes ("N panes, 1
// soul"). isSelfReview/resolveReviewer only ever compared oracle NAMES, so a genuinely
// independent reviewer pane of the same crew (worker %103 → reviewer %104, both
// "stitch") got refused outright (`--to stitch`) or, without `--to`, silently downgraded
// to "falls to human" — Tony pinged despite a real second pair of eyes already on it.
// This tests the pane-aware fix: isSelfReviewPaneAware + a `--to-pane`-qualified CLI
// dispatch that records `reviewerPane`, which resolveReviewer now honors as proof of
// independence. Precedent: kobo-346 made SIGN pane-aware the same way; kobo-328's
// self-review ban itself is NOT touched — same-pane is still refused (AC2).
//
// review-round-2 (reviewer %104, PR#386 c1 — real live tmux probe, 4 cases): the FIRST
// version resolved `--to-pane` against ANY tmux address, including a DIFFERENT
// company's pane (`30-stitch:0.2 --to-pane 28-bob:0.2` was silently accepted —
// companyScopeViolation only checks the bare oracle name, never the pane). Fixed by
// requiring the target to be in the CALLER's own tmux session (sameTmuxSession, tested
// below) — "N panes, 1 soul" means one crew CELL = one session, not "any live pane
// anywhere". AC1 CEILING, stated plainly per the reviewer's ask: this suite's CLI-level
// tests run with `TMUX` deleted (no real tmux in CI), so `resolvePaneIdInCallerSession`
// always returns null there and every CLI case below exercises the REFUSE/fallback
// path only — the "system accepts + records reviewerPane" behavior is proven at the
// pure-function level (isSelfReviewPaneAware, sameTmuxSession) and was verified
// manually by the reviewer against real tmux panes, NOT by an automated CI run.

describe("kobo-587: parseReviewTarget", () => {
  test("bare oracle name → no pane", () => {
    expect(parseReviewTarget("stitch")).toEqual({ oracle: "stitch", pane: null });
  });
  test("oracle@%paneId → both parsed", () => {
    expect(parseReviewTarget("stitch@%42")).toEqual({ oracle: "stitch", pane: "%42" });
  });
  test("malformed pane suffix (not %digits) → treated as no pane info", () => {
    expect(parseReviewTarget("stitch@notapane")).toEqual({ oracle: "stitch", pane: null });
  });
});

// review-round-2: the session-scoping fix itself, at the pure-logic level —
// resolvePaneIdInCallerSession (the impure tmux-querying wrapper around this) can't be
// exercised in CI without a real tmux session (see file header AC1 ceiling note), but
// the JUDGMENT it makes — same session vs different session — is plain string
// comparison and fully covered here without needing tmux at all.
describe("kobo-587 review-round-2: sameTmuxSession", () => {
  test("same session name on both sides → true", () => {
    expect(sameTmuxSession("30-stitch", "30-stitch")).toBe(true);
  });
  test("different session names (the exact cross-company case the reviewer probed) → false", () => {
    expect(sameTmuxSession("30-stitch", "28-bob")).toBe(false);
  });
  test("caller session unresolved (null) → false, never treated as a match", () => {
    expect(sameTmuxSession(null, "30-stitch")).toBe(false);
  });
  test("target session unresolved (null) → false, never treated as a match", () => {
    expect(sameTmuxSession("30-stitch", null)).toBe(false);
  });
  test("both null → false", () => {
    expect(sameTmuxSession(null, null)).toBe(false);
  });
});

describe("kobo-587: isSelfReviewPaneAware", () => {
  const t = addTask({ company: "kobo", title: "c", by: "eq3", assignee: "stitch" });

  test("AC4 — bare oracle name, same as assignee → REFUSE (unchanged from isSelfReview)", () => {
    expect(isSelfReviewPaneAware(t, "stitch", "%1")).toBe(true);
    expect(isSelfReviewPaneAware(t, "stitch", "%1")).toBe(isSelfReview(t, "stitch"));
  });

  test("AC4 — bare oracle name, different oracle → not self-review (unchanged)", () => {
    expect(isSelfReviewPaneAware(t, "eq3", "%1")).toBe(false);
    expect(isSelfReviewPaneAware(t, "eq3", "%1")).toBe(isSelfReview(t, "eq3"));
  });

  test("AC1 — pane-qualified, same oracle, DIFFERENT pane from caller → NOT self-review", () => {
    expect(isSelfReviewPaneAware(t, "stitch@%104", "%103")).toBe(false);
  });

  test("AC2 — pane-qualified, same oracle, SAME pane as caller → still self-review (kobo-328 not weakened)", () => {
    expect(isSelfReviewPaneAware(t, "stitch@%103", "%103")).toBe(true);
  });

  test("pane-qualified target but caller has no pane info (outside tmux) → falls back to oracle-name check", () => {
    expect(isSelfReviewPaneAware(t, "stitch@%104", null)).toBe(true); // no caller pane to compare against → can't prove independence, stays refused
  });

  test("different oracle even when pane-qualified → never self-review regardless of pane match", () => {
    expect(isSelfReviewPaneAware(t, "eq3@%103", "%103")).toBe(false);
  });
});

describe("kobo-587: resolveReviewer honors reviewerPane as independence proof", () => {
  test("reviewer === assignee, no reviewerPane → falls through (kobo-328 original behavior, AC4)", () => {
    const t = addTask({ company: "kobo", title: "c", by: "stitch", assignee: "stitch", reviewer: "stitch" });
    expect(resolveReviewer(t)).toBe("human"); // by === assignee too, so creator-chain also exhausted
  });

  test("reviewer === assignee WITH reviewerPane recorded → treated as independent (AC1)", () => {
    const t = addTask({ company: "kobo", title: "c", by: "stitch", assignee: "stitch", reviewer: "stitch" });
    t.reviewerPane = "%104";
    expect(resolveReviewer(t)).toBe("stitch"); // not "human" — the pane proves a distinct reviewer accepted it
  });
});

// AC3 mutation test — proves the pane-comparison branch is load-bearing, by removing it
// and confirming the behavior collapses back to plain isSelfReview (i.e. the guard we
// just wrote actually watches, not green because nothing runs).
describe("kobo-587: mutation test — pane-comparison branch must be load-bearing", () => {
  function isSelfReviewPaneAwareWithoutPaneBranch(task: { assignee: string }, to: string): boolean {
    // the mutant: strip the `if (target.pane && callerPane) return target.pane === callerPane;`
    // branch entirely — this is what the real function degrades to if that line is deleted.
    const target = parseReviewTarget(to);
    if (target.oracle !== task.assignee) return false;
    return isSelfReview(task as never, target.oracle);
  }

  test("without the pane branch, a genuinely independent reviewer pane is wrongly refused", () => {
    const t = addTask({ company: "kobo", title: "c", by: "eq3", assignee: "stitch" });
    // real function: different pane → independent → false
    expect(isSelfReviewPaneAware(t, "stitch@%104", "%103")).toBe(false);
    // mutant (branch removed): can't tell panes apart → wrongly says self-review → true
    expect(isSelfReviewPaneAwareWithoutPaneBranch(t, "stitch@%104")).toBe(true);
  });
});

// CLI-level coverage, in-process against the real command engine (same harness shape as
// test/isolated/plugin-task-reviewer-routing.test.ts's kobo-328 coverage).
const dir = mkdtempSync(join(tmpdir(), "maw-revpane-"));
const prev = process.env.MAW_DATA_DIR;
const prevAgent = process.env.CLAUDE_AGENT_NAME;
const prevTest = process.env.MAW_TEST_MODE;
const prevTmux = process.env.TMUX;

beforeAll(() => {
  process.env.MAW_DATA_DIR = dir;
  process.env.CLAUDE_AGENT_NAME = "stitch";
  process.env.MAW_TEST_MODE = "1";
  delete process.env.TMUX; // kobo-587: no real tmux in CI — --to-pane resolves to null, so these CLI cases exercise the bare-oracle-name fallback path only (AC4); the pane-comparison branch itself is covered directly above against the pure function, which needs no tmux
  mkdirSync(join(dir, "companies"), { recursive: true });
  writeFileSync(
    join(dir, "companies", "kobo.json"),
    JSON.stringify({ name: "kobo", departments: { core: { members: [{ oracle: "stitch" }, { oracle: "eq3" }], lead: "eq3" } } }),
  );
});
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prev;
  if (prevAgent === undefined) delete process.env.CLAUDE_AGENT_NAME; else process.env.CLAUDE_AGENT_NAME = prevAgent;
  if (prevTest === undefined) delete process.env.MAW_TEST_MODE; else process.env.MAW_TEST_MODE = prevTest;
  if (prevTmux === undefined) delete process.env.TMUX; else process.env.TMUX = prevTmux;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { rmSync(join(dir, "companies", "kobo", "tasks"), { recursive: true, force: true }); });

const run = async (args: string[]) => {
  const out: string[] = [];
  const r = await runTask(args, (l) => out.push(l));
  return { ...r, output: out.join("\n") };
};
const task = (args: string[]) => run([...args, "--company", "kobo", "--from", "local:stitch"]);

describe("kobo-587: CLI review --to-pane, no tmux present (AC4 fallback path, unchanged existing behavior)", () => {
  test("review --to <assignee> --to-pane <addr>, unresolvable (no tmux) → still REFUSE, same message as before", async () => {
    await task(["add", "c", "--assignee", "stitch"]);
    const r = await task(["review", "kobo-1", "--to", "stitch", "--to-pane", "30-stitch:0.2"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("self-review banned");
  });

  test("review --to <independent oracle>, no --to-pane at all → unaffected, ok as before", async () => {
    await task(["add", "c", "--assignee", "stitch"]);
    const r = await task(["review", "kobo-1", "--to", "eq3"]);
    expect(r.ok).toBe(true);
    expect(readTask("kobo", "kobo-1")!.reviewer).toBe("eq3");
    expect(readTask("kobo", "kobo-1")!.reviewerPane).toBeUndefined();
  });
});
