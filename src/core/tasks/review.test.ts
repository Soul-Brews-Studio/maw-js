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
    for (const s of ["backlog", "todo", "in-progress", "review", "done", "needs-attention"] as const) {
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
    expect(taskNextAction(mk({ state: "review", pr: 53 }))).toBe("รอ merge PR #53 → done");
  });
  test("needs-attention surfaces the ask", () => {
    expect(taskNextAction(mk({ state: "needs-attention", attention: { for: "tony", reason: "approve" } }))).toBe("⚑ ขอ tony: approve");
  });
});
