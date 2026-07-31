import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  addTask, addTaskEvidence, completeTask, markReadyForExternalReview, readTask, rejectTask, reopenTask, reviewTask,
} from "../src/core/tasks/store";
import { evidenceScopeLocusConflict, parkedCardRate, prCardMismatch, stuckCards } from "../src/core/tasks/probes";

const dir = mkdtempSync(join(tmpdir(), "maw-cell-v2-"));
const prior = process.env.MAW_DATA_DIR;
beforeAll(() => { process.env.MAW_DATA_DIR = dir; });
afterAll(() => {
  if (prior === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prior;
  rmSync(dir, { recursive: true, force: true });
});

describe("Cell v2 foundation", () => {
  test("preserves reviewer routing through close/reopen and counts review rejects", () => {
    const t = addTask({ company: "cell", title: "durable card", by: "main", assignee: "worker", reviewer: "reviewer", reviewerCellId: "cell-b" });
    reviewTask("cell", t.id, "worker", { to: "reviewer", cellId: "cell-b" });
    expect(completeTask("cell", t.id, "reviewer")).toMatchObject({ state: "done", reviewer: "reviewer", reviewerCellId: "cell-b" });
    expect(reopenTask("cell", t.id, "main", "review")).toMatchObject({ state: "review", reviewer: "reviewer", reviewerCellId: "cell-b" });
    expect(rejectTask("cell", t.id, "reviewer", "needs changes")).toMatchObject({ state: "rejected", reviewRejectCount: 1, reviewerCellId: "cell-b" });
    expect(reopenTask("cell", t.id, "main")).toMatchObject({ state: "todo", reviewer: "reviewer", reviewerCellId: "cell-b" });
    expect(rejectTask("cell", t.id, "reviewer", "still unsafe")).toMatchObject({ state: "need-answer", reviewRejectCount: 2, reviewerCellId: "cell-b" });
  });

  test("requires structured producer evidence before readiness and separates loci", () => {
    const t = addTask({ company: "cell", title: "evidence", by: "main", assignee: "worker", reviewer: "reviewer" });
    expect(markReadyForExternalReview("cell", t.id, "worker")).toBeNull();
    expect(addTaskEvidence("cell", t.id, "worker", { scope: "producer", changed: "field", verified: "named test", locus: "worktree-a", limitations: "no deploy" })).not.toBeNull();
    expect(markReadyForExternalReview("cell", t.id, "worker")).not.toBeNull();
    reviewTask("cell", t.id, "worker", { to: "reviewer", cellId: "cell-b" });
    expect(readTask("cell", t.id)?.readyForExternalReviewAt).toBeNumber();
    expect(evidenceScopeLocusConflict({ ...readTask("cell", t.id)!, evidence: [{ scope: "producer", changed: "x", verified: "y", locus: "same", limitations: "z", by: "a", ts: 1 }, { scope: "independent", changed: "x", verified: "y", locus: "same", limitations: "z", by: "b", ts: 2 }] })).toBe(true);
  });

  test("pull probes split role age, parked pressure, and PR mismatch", () => {
    const tasks = [
      { id: "a", title: "a", company: "cell", state: "in-progress", by: "main", assignee: "w", ts: 1, updatedTs: 1 },
      { id: "b", title: "b", company: "cell", state: "review", by: "main", assignee: "w", reviewer: "r", ts: 1, updatedTs: 1 },
      { id: "c", title: "c", company: "cell", state: "external-wait", by: "main", assignee: "w", externalWaitTrigger: "callback", ts: 1, updatedTs: 1 },
    ] as const;
    expect(stuckCards([...tasks], 3_600_001, 4_000_000)).toEqual([]); // no card reaches a four-million-ms threshold
    expect(stuckCards([...tasks], 3_600_000, 100).map((x) => x.role)).toEqual(["worker", "reviewer", "external-wait"]);
    expect(parkedCardRate([...tasks], 0, 3_600_000).parked).toBe(1);
    expect(prCardMismatch({ ...tasks[1], pr: 42 }, { state: "MERGED", merged: true }).mismatch).toBe(true);
    expect(prCardMismatch({ ...tasks[1], pr: 42 }, null).reason).toContain("unverified");
  });
});
