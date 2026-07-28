import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  addTask,
  claimTask,
  completeTask,
  findTaskByPr,
  parsePrNumber,
  reviewTask,
  setTaskPr,
  taskNextAction,
  type TaskRecord,
} from "./store";

const dir = mkdtempSync(join(tmpdir(), "maw-review-"));
const prev = process.env.MAW_DATA_DIR;
beforeAll(() => { process.env.MAW_DATA_DIR = dir; });
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { rmSync(join(dir, "companies"), { recursive: true, force: true }); });

const mk = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  id: "pgw-1", title: "t", company: "pgw", state: "todo", by: "eq3", assignee: null, ts: 1, ...over,
});

describe("review flow (Track 4)", () => {
  test("reviewTask → review state + reviewer/reason", () => {
    addTask({ company: "pgw", title: "x", by: "eq3", assignee: "patchwork" });
    const t = reviewTask("pgw", "pgw-1", "patchwork", { to: "eq3", reason: "check logic" })!;
    expect(t.state).toBe("review");
    expect(t.reviewer).toBe("eq3");
    expect(t.reviewReason).toBe("check logic");
  });

  test("reviewTask with no --to → anyone can review (reviewer unset)", () => {
    addTask({ company: "pgw", title: "x", by: "eq3" });
    const t = reviewTask("pgw", "pgw-1", "eq3")!;
    expect(t.state).toBe("review");
    expect(t.reviewer).toBeUndefined();
  });

  test("claim from review = hand-off → in-progress, clears reviewer (ADR exit)", () => {
    addTask({ company: "pgw", title: "x", by: "eq3" });
    reviewTask("pgw", "pgw-1", "eq3", { to: "patchwork" });
    const t = claimTask("pgw", "pgw-1", "patchwork")!;
    expect(t.state).toBe("in-progress");
    expect(t.assignee).toBe("patchwork");
    expect(t.reviewer).toBeUndefined();
  });

  test("setTaskPr → attaches PR + moves to review", () => {
    addTask({ company: "pgw", title: "x", by: "eq3", assignee: "patchwork" });
    const t = setTaskPr("pgw", "pgw-1", 53, "patchwork")!;
    expect(t.pr).toBe(53);
    expect(t.state).toBe("review");
  });

  test("findTaskByPr finds the non-done task carrying a PR (PR-watch auto-done)", () => {
    addTask({ company: "pgw", title: "x", by: "eq3", assignee: "patchwork" });
    setTaskPr("pgw", "pgw-1", 53, "patchwork");
    expect(findTaskByPr("pgw", 53)?.id).toBe("pgw-1");
    completeTask("pgw", "pgw-1", "tony");
    expect(findTaskByPr("pgw", 53)).toBeNull(); // done tasks excluded
  });

  test("parsePrNumber extracts the PR number from a reply with a GH url", () => {
    expect(parsePrNumber("done → https://github.com/meganechan/maw-js/pull/53 ✅")).toBe(53);
    expect(parsePrNumber("no link here")).toBeNull();
    expect(parsePrNumber("just #53 mentioned")).toBeNull(); // only real PR urls
  });
});

describe("taskNextAction — every state answers 'what next + who'", () => {
  test("never empty across all states", () => {
    for (const s of ["backlog", "todo", "in-progress", "review", "done", "blocked"] as const) {
      expect(taskNextAction(mk({ state: s })).length).toBeGreaterThan(0);
    }
  });
  test("in-progress: wait-for vs working", () => {
    expect(taskNextAction(mk({ state: "in-progress", by: "eq3", assignee: "patchwork" }))).toBe("eq3 รอ patchwork");
    expect(taskNextAction(mk({ state: "in-progress", by: "eq3", assignee: "eq3" }))).toBe("eq3 กำลังทำ");
    expect(taskNextAction(mk({ state: "in-progress", assignee: null }))).toBe("รอคนหยิบ");
  });
  test("review: reviewer vs PR", () => {
    expect(taskNextAction(mk({ state: "review", reviewer: "eq3" }))).toBe("รอ eq3 ตรวจ");
    expect(taskNextAction(mk({ state: "review" }))).toBe("รอ ใครก็ได้ ตรวจ");
    // kobo-576: stale-signature check takes priority over the PR-mergeable check
    // below (kobo-594) — a person must re-sign regardless of the PR's own state.
    expect(taskNextAction(mk({ state: "review", pr: 53, crewGate: true, crewSignedSha: "sha-A", headSignedSha: "sha-B" }))).toContain("เซ็นคนละ commit");
  });

  // kobo-594 — a card with all signs in + a PR link used to read as "just needs a
  // merge click" with NOTHING checking whether the PR was actually mergeable on
  // GitHub. Proven live: alpha absorbing sibling PRs flipped #371/#375 CONFLICTING
  // in the same minute while their cards still said "รอ merge" — no field on the
  // board represented real PR state at all.
  describe("review + PR: mergeable state must be checked, never assumed (kobo-594)", () => {
    test("prMergeable never set (never successfully checked) → must NOT read as ready", () => {
      const next = taskNextAction(mk({ state: "review", pr: 53 }));
      expect(next).toContain("PR #53");
      expect(next).toContain("ยังไม่เคยเช็ค"); // explicit "not confirmed" caveat
      expect(next).not.toBe("รอ merge PR #53 → done"); // the OLD bare claim must not survive unqualified
    });

    // kobo-594 review round 2 (eq3's c5) — real bug found via a LIVE render, not
    // a diff read: "never checked" and "checked, GitHub itself hadn't resolved
    // it yet" are DIFFERENT facts and must be 3 distinct states, not 2. This
    // exact PR's own comment already said so; the message code collapsed them
    // anyway. "checked, still unknown" must say IT WAS CHECKED + when, never
    // claim "ยังไม่เคยเช็ค" (never checked) — that's a lie once a check ran.
    test("checked but GitHub itself hadn't resolved mergeable yet (UNKNOWN + a real checked timestamp) → says CHECKED, not never-checked", () => {
      const next = taskNextAction(mk({ state: "review", pr: 53, prMergeable: "UNKNOWN", prMergeStateStatus: "UNKNOWN", prMergeCheckedTs: Date.now() }));
      expect(next).not.toContain("ยังไม่เคยเช็คสถานะ"); // must NOT claim never-checked — it WAS checked
      expect(next).toContain("เช็คแล้ว"); // must say a check DID happen
      expect(next).toContain("gh ด้วยมือ"); // still carries the manual-verify caveat — UNKNOWN is still not confirmed ready
    });

    // kobo-594 review round 3 (reviewer's own undeclared mutation): prMergeable
    // === "UNKNOWN" with NO checked timestamp can't happen via the real write
    // path today (setTaskPrMergeState always sets both together) — but this
    // guard is what stops it from lying "checked" with a NaN-age if a future
    // second writer, migration, or legacy record ever sets one without the
    // other. Removing `&& task.prMergeCheckedTs` makes this test go red.
    test("UNKNOWN with NO checked timestamp (malformed/future-writer record) never claims 'checked' with a NaN age", () => {
      const next = taskNextAction(mk({ state: "review", pr: 53, prMergeable: "UNKNOWN", prMergeStateStatus: "UNKNOWN" })); // no prMergeCheckedTs
      expect(next).not.toContain("NaN");
      expect(next).not.toContain("เช็คแล้วแต่"); // must NOT take the "checked, still unknown" branch without a real timestamp
      expect(next).toContain("ยังไม่เคยเช็คสถานะ"); // falls back to the honest "never checked" claim instead
    });

    test("genuinely never checked (prMergeable absent entirely) → says never-checked, distinct from the checked-but-UNKNOWN case above", () => {
      const next = taskNextAction(mk({ state: "review", pr: 53 }));
      expect(next).toContain("ยังไม่เคยเช็คสถานะ");
    });

    // kobo-594 — live evidence eq3 measured while merging this batch of PRs
    // (not a hypothetical): the SAME UNKNOWN value resolved to BOTH real states
    // on re-check — #375/#371 UNKNOWN → CONFLICTING after merging 576, #588
    // UNKNOWN → MERGEABLE after merging 592. UNKNOWN alone carries zero
    // direction — defaulting it to "ready" (the old bug) would have merged
    // straight over a real conflict.
    test("UNKNOWN resolves EITHER direction on re-check — proves it can never be treated as ready by default", () => {
      const stillUnknown = mk({ state: "review", pr: 371, prMergeable: "UNKNOWN", prMergeStateStatus: "UNKNOWN", prMergeCheckedTs: Date.now() });
      const unknownMsg = taskNextAction(stillUnknown);
      expect(unknownMsg).not.toContain(`PR #${stillUnknown.pr} conflict`); // not the resolved-conflict wording
      expect(unknownMsg).not.toContain("⚠"); // not the conflict warning marker
      expect(unknownMsg).toContain("เช็คแล้ว"); // checked, just not resolved — never silently "ready"

      const resolvedConflicting = { ...stillUnknown, prMergeable: "CONFLICTING", prMergeStateStatus: "DIRTY" };
      expect(taskNextAction(resolvedConflicting)).toContain("conflict");

      const resolvedMergeable = { ...stillUnknown, pr: 377, prMergeable: "MERGEABLE", prMergeStateStatus: "CLEAN" };
      expect(taskNextAction(resolvedMergeable)).toContain("รอ merge PR #377 → done");
    });

    test("prMergeable CONFLICTING → explicit conflict warning, distinct from ready", () => {
      const next = taskNextAction(mk({ state: "review", pr: 53, prMergeable: "CONFLICTING", prMergeStateStatus: "DIRTY", prMergeCheckedTs: Date.now() }));
      expect(next).toContain("conflict");
      expect(next).toContain("PR #53");
      expect(next).not.toContain("รอ merge PR #53 → done");
    });

    test("prMergeable MERGEABLE → reads as ready, the original message", () => {
      const next = taskNextAction(mk({ state: "review", pr: 53, prMergeable: "MERGEABLE", prMergeStateStatus: "CLEAN", prMergeCheckedTs: Date.now() }));
      expect(next).toContain("รอ merge PR #53 → done");
      expect(next).not.toContain("conflict");
      expect(next).not.toContain("ยังไม่เคยเช็ค");
    });

    test("checked timestamp is readable in the message when present — staleness must not be silent", () => {
      const tenMinAgo = Date.now() - 10 * 60_000;
      const next = taskNextAction(mk({ state: "review", pr: 53, prMergeable: "MERGEABLE", prMergeStateStatus: "CLEAN", prMergeCheckedTs: tenMinAgo }));
      expect(next).toContain("10 นาทีที่แล้ว");
    });
  });
  test("blocked surfaces the kind + who-clears + why", () => {
    expect(taskNextAction(mk({ state: "blocked", block: { kind: "needs_input", for: "tony", reason: "approve" } }))).toBe("⚑ [needs_input] รอ tony: approve");
    expect(taskNextAction(mk({ state: "blocked", block: { kind: "transient" } }))).toBe("⚑ [transient]");
  });
});
