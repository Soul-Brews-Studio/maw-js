import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  addTask,
  archiveDir,
  archivedTaskFilePath,
  archiveOldDone,
  archiveTask,
  askTask,
  assignTask,
  TASK_FLOW,
  TASK_STATES,
  mentionKey,
  parseMentions,
  pendingMentions,
  BLOCK_KINDS,
  blockNextAction,
  archiveTask,
  blockTask,
  checklistProgress,
  claimTask,
  commentTask,
  migrateQuestionNotesToComments,
  completeTask,
  resolveComment,
  isStaleDecisionCard,
  lastActivityByOracle,
  STALE_DECISION_MS,
  createsEpicLoop,
  decomposeEpic,
  DEFAULT_ARCHIVE_DAYS,
  dependencyBlock,
  descendantCards,
  epicChildren,
  EpicArchiveBlockedError,
  epicRollup,
  familyNotes,
  isBlockedByDependency,
  isOnBoard,
  listArchivedTasks,
  listTasks,
  needsOwner,
  nextTaskId,
  noteTask,
  openEpicChildren,
  parentStateResolver,
  prOpenedReview,
  readTask,
  rejectTask,
  parsePrRepo,
  resolveEpicParent,
  resolveReviewer,
  reviewTask,
  holdTask,
  approveTask,
  moveTask,
  createsDepLoop,
  setTaskDep,
  setTaskEpic,
  setTaskPr,
  setTaskRepoIfMissing,
  startTask,
  taskFilePath,
  taskNextAction,
  tasksDir,
  tryCreateTaskRecord,
  unblockTask,
  type ParentState,
  type TaskRecord,
} from "./store";
import { openClaims, readWorklog } from "../worklog/store";

const dir = mkdtempSync(join(tmpdir(), "maw-tasks-"));
const prev = process.env.MAW_DATA_DIR;

beforeAll(() => { process.env.MAW_DATA_DIR = dir; });
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { rmSync(join(dir, "companies"), { recursive: true, force: true }); });

describe("task store (file-per-card under Company Home)", () => {
  test("addTask writes a card under companies/<c>/tasks/ + emits task-created", () => {
    const t = addTask({ company: "pgw", title: "ship board", by: "eq3" });
    expect(t.id).toBe("pgw-1");
    expect(t.state).toBe("todo");
    expect(t.assignee).toBeNull();
    expect(existsSync(taskFilePath("pgw", "pgw-1"))).toBe(true);
    const wl = readWorklog("pgw");
    expect(wl.some((e) => e.kind === "task-created" && e.task === "pgw-1")).toBe(true);
  });

  test("addTask pre-assigned still starts todo (delegating ahead ≠ started)", () => {
    const t = addTask({ company: "pgw", title: "fix bug", by: "eq3", assignee: "patchwork" });
    expect(t.state).toBe("todo");
    expect(t.assignee).toBe("patchwork");
  });

  test("addTask with explicit state honors it (dispatch path)", () => {
    const t = addTask({ company: "pgw", title: "dispatched", by: "eq3", assignee: "patchwork", state: "in-progress" });
    expect(t.state).toBe("in-progress");
  });

  test("startTask: todo → in-progress, sets assignee + emits claim", () => {
    addTask({ company: "pgw", title: "t", by: "eq3" });
    const started = startTask("pgw", "pgw-1", "patchwork");
    expect(started?.state).toBe("in-progress");
    expect(started?.assignee).toBe("patchwork");
    expect(openClaims("pgw").some((c) => c.oracle === "patchwork" && c.task === "pgw-1")).toBe(true);
  });

  test("startTask keeps an existing assignee (assignee picks up their own work)", () => {
    addTask({ company: "pgw", title: "t", by: "eq3", assignee: "tony" });
    const started = startTask("pgw", "pgw-1", "tony");
    expect(started?.assignee).toBe("tony");
    expect(started?.state).toBe("in-progress");
  });

  test("startTask on a missing id → null (no throw)", () => {
    expect(startTask("pgw", "pgw-999", "x")).toBeNull();
  });

  test("ids increment per company and never collide across companies", () => {
    addTask({ company: "pgw", title: "a", by: "x" });
    addTask({ company: "pgw", title: "b", by: "x" });
    expect(nextTaskId("pgw")).toBe("pgw-3");
    addTask({ company: "kobo", title: "c", by: "y" });
    expect(nextTaskId("kobo")).toBe("kobo-2");
  });

  test("claimTask sets assignee + in-progress + emits claim", () => {
    addTask({ company: "pgw", title: "t", by: "eq3" });
    const claimed = claimTask("pgw", "pgw-1", "patchwork");
    expect(claimed?.assignee).toBe("patchwork");
    expect(claimed?.state).toBe("in-progress");
    expect(readTask("pgw", "pgw-1")?.assignee).toBe("patchwork");
    expect(readWorklog("pgw").some((e) => e.kind === "claim" && e.task === "pgw-1")).toBe(true);
  });

  test("assignTask hands the ball: sets assignee=to, keeps state, by stays real actor (mawjs-5)", () => {
    addTask({ company: "pgw", title: "decide the thing", by: "eq3" });
    claimTask("pgw", "pgw-1", "patchwork"); // owner takes it → in-progress @patchwork
    const assigned = assignTask("pgw", "pgw-1", "human", "patchwork");
    expect(assigned?.assignee).toBe("human"); // ball flipped to the human decider
    expect(assigned?.state).toBe("in-progress"); // state untouched — NOT taken, just handed
    expect(readTask("pgw", "pgw-1")?.assignee).toBe("human");
    // board next-action reads "<creator> รอ <assignee>" — waiting on the human decider
    expect(taskNextAction(readTask("pgw", "pgw-1")!)).toBe("eq3 รอ human");
    // the worklog event is stamped with the REAL assigner (patchwork) — no impersonation of human
    expect(readWorklog("pgw").some((e) => e.kind === "task-updated" && e.task === "pgw-1" && e.oracle === "patchwork")).toBe(true);
  });

  test("assignTask on a missing id → null (no throw)", () => {
    expect(assignTask("pgw", "pgw-999", "human", "x")).toBeNull();
  });

  // kobo-211 — reassign A→B releases A's stale worklog claim (the "⛏ old-holder"
  // that used to linger after `assign --to`, needing manual archive/claim cleanup).
  test("assignTask releases the previous holder's open claim (kobo-211)", () => {
    addTask({ company: "pgw", title: "t", by: "eq3" });
    claimTask("pgw", "pgw-1", "human"); // human holds → open claim ⛏ human
    expect(openClaims("pgw").some((c) => (c.task ?? c.summary) === "pgw-1" && c.oracle === "human")).toBe(true);
    assignTask("pgw", "pgw-1", "eq3", "eq3"); // reassign to eq3
    const claims = openClaims("pgw").filter((c) => (c.task ?? c.summary) === "pgw-1");
    expect(claims.some((c) => c.oracle === "human")).toBe(false); // old holder freed
    expect(claims.length).toBe(0); // reassign never fabricates a claim for the new owner
  });

  // A done/archived card was already claim-released; reassigning it must not resurrect
  // an orphan claim (AC: done/archived reassigned → no orphan).
  test("assignTask on a done card leaves no orphan claim (kobo-211)", () => {
    addTask({ company: "pgw", title: "t", by: "eq3" });
    claimTask("pgw", "pgw-1", "human");
    completeTask("pgw", "pgw-1", "tony"); // releases human's claim
    assignTask("pgw", "pgw-1", "eq3", "eq3");
    expect(openClaims("pgw").filter((c) => (c.task ?? c.summary) === "pgw-1").length).toBe(0);
  });

  test("isStaleDecisionCard: in-progress + no-PR + owner silent past window → true (visual only)", () => {
    const now = 10_000_000;
    const card = { state: "in-progress", assignee: "patchwork", pr: undefined } as TaskRecord;
    expect(isStaleDecisionCard(card, now - STALE_DECISION_MS - 1, now)).toBe(true); // silent past window
    expect(isStaleDecisionCard(card, now - 1000, now)).toBe(false); // just active
    expect(isStaleDecisionCard(card, undefined, now)).toBe(true); // no activity at all = silent
  });

  test("isStaleDecisionCard: PR / unassigned / non-in-progress cards are never stale", () => {
    const now = 10_000_000;
    const old = now - STALE_DECISION_MS - 1;
    expect(isStaleDecisionCard({ state: "in-progress", assignee: "p", pr: 42 } as TaskRecord, old, now)).toBe(false); // has PR (pr-watch drives it)
    expect(isStaleDecisionCard({ state: "in-progress", assignee: null } as TaskRecord, old, now)).toBe(false); // unassigned
    expect(isStaleDecisionCard({ state: "todo", assignee: "p" } as TaskRecord, old, now)).toBe(false); // not in-progress
  });

  test("lastActivityByOracle: newest ts per oracle, excludes idle heartbeats", () => {
    addTask({ company: "pgw", title: "a", by: "eq3" }); // eq3 emits task-created
    claimTask("pgw", "pgw-1", "patchwork"); // patchwork emits claim
    const map = lastActivityByOracle("pgw");
    expect(map["patchwork"]).toBeGreaterThan(0);
    expect(map["eq3"]).toBeGreaterThan(0);
    expect(map["patchwork"]).toBeGreaterThanOrEqual(map["eq3"]); // claim came after create
  });

  test("completeTask → done + emits task-done", () => {
    addTask({ company: "pgw", title: "t", by: "eq3" });
    const done = completeTask("pgw", "pgw-1", "tony");
    expect(done?.state).toBe("done");
    expect(readWorklog("pgw").some((e) => e.kind === "task-done" && e.task === "pgw-1")).toBe(true);
  });

  test("done releases the holder's open claim — maw watch doesn't go stale (handoff fix B)", () => {
    addTask({ company: "pgw", title: "t", by: "eq3" });
    claimTask("pgw", "pgw-1", "patchwork");
    expect(openClaims("pgw").some((c) => c.task === "pgw-1")).toBe(true); // claim is open
    completeTask("pgw", "pgw-1", "tony"); // closed by someone else — release keys on assignee, not `by`
    expect(openClaims("pgw").some((c) => c.task === "pgw-1")).toBe(false); // released
  });

  // kobo-107 — release ALL open claims on a card, not just the current assignee's.
  // A card claimed by A then re-claimed by B leaves TWO open claims (A + B, keyed
  // per holder); closing/rejecting/archiving used to free only the assignee's,
  // leaving the other stale (→ false-positive idle-with-work, kobo-105).
  test("done releases ALL open claims on the card, not just the assignee's (kobo-107)", () => {
    addTask({ company: "pgw", title: "t", by: "eq3" });
    claimTask("pgw", "pgw-1", "patchwork"); // holder A
    claimTask("pgw", "pgw-1", "human");     // holder B — assignee is now human
    expect(openClaims("pgw").filter((c) => (c.task ?? c.summary) === "pgw-1").length).toBe(2);
    completeTask("pgw", "pgw-1", "eq3");     // closed by a THIRD party
    expect(openClaims("pgw").filter((c) => (c.task ?? c.summary) === "pgw-1").length).toBe(0); // both gone
  });

  test("reject releases ALL open claims on the card (kobo-107)", () => {
    addTask({ company: "pgw", title: "t", by: "eq3" });
    claimTask("pgw", "pgw-1", "patchwork");
    claimTask("pgw", "pgw-1", "human");
    rejectTask("pgw", "pgw-1", "eq3", "not needed");
    expect(openClaims("pgw").filter((c) => (c.task ?? c.summary) === "pgw-1").length).toBe(0);
  });

  test("archive releases ALL open claims on the card (kobo-107)", () => {
    addTask({ company: "pgw", title: "t", by: "eq3" });
    claimTask("pgw", "pgw-1", "patchwork");
    claimTask("pgw", "pgw-1", "human");
    archiveTask("pgw", "pgw-1", "eq3");
    expect(openClaims("pgw").filter((c) => (c.task ?? c.summary) === "pgw-1").length).toBe(0);
  });

  test("noteTask appends notes (append-only) with author + ts, keeps prior notes, emits task-note", () => {
    addTask({ company: "pgw", title: "t", by: "eq3" });
    const a = noteTask("pgw", "pgw-1", "patchwork", "first note");
    const b = noteTask("pgw", "pgw-1", "tony", "second note");
    expect(b?.notes?.length).toBe(2);
    // append-only: first note is preserved verbatim, order is oldest-first
    expect(b?.notes?.[0].text).toBe("first note");
    expect(b?.notes?.[0].by).toBe("patchwork");
    expect(b?.notes?.[1].text).toBe("second note");
    expect(b?.notes?.[1].by).toBe("tony");
    expect(b?.notes?.[0].ts).toBeLessThanOrEqual(b!.notes![1].ts);
    // persisted to disk, not just returned
    expect(readTask("pgw", "pgw-1")?.notes?.length).toBe(2);
    // existing fields untouched
    expect(readTask("pgw", "pgw-1")?.state).toBe("todo");
    expect(readWorklog("pgw").filter((e) => e.kind === "task-note" && e.task === "pgw-1").length).toBe(2);
    void a;
  });

  test("noteTask on a missing id → null (no throw)", () => {
    expect(noteTask("pgw", "pgw-999", "x", "hi")).toBeNull();
  });

  // kobo-54 — board-truth: a note by the assignee on their own todo card is
  // "I'm working on this" evidence → auto-advance todo→in-progress (no lying).
  test("noteTask by the assignee on a todo card auto-advances todo→in-progress + emits claim", () => {
    addTask({ company: "pgw", title: "t", by: "eq3", assignee: "patchwork" });
    const n = noteTask("pgw", "pgw-1", "patchwork", "diagnosing the repro");
    expect(n?.state).toBe("in-progress");
    expect(readTask("pgw", "pgw-1")?.state).toBe("in-progress"); // persisted
    expect(openClaims("pgw").some((c) => c.oracle === "patchwork" && c.task === "pgw-1")).toBe(true);
  });

  test("noteTask by a NON-assignee on a todo card keeps it todo (no lying)", () => {
    addTask({ company: "pgw", title: "t", by: "eq3", assignee: "patchwork" });
    const n = noteTask("pgw", "pgw-1", "eq3", "any progress on this?"); // eq3 asks, not the doer
    expect(n?.state).toBe("todo");
    expect(openClaims("pgw").some((c) => c.task === "pgw-1")).toBe(false);
  });

  test("noteTask on an UNASSIGNED todo card does not auto-advance (fall back to explicit start)", () => {
    addTask({ company: "pgw", title: "t", by: "eq3" }); // no assignee
    const n = noteTask("pgw", "pgw-1", "patchwork", "picking this up");
    expect(n?.state).toBe("todo");
  });

  test("noteTask on an in-progress/done card leaves state unchanged (idempotent, never resurrects)", () => {
    addTask({ company: "pgw", title: "t", by: "eq3", assignee: "patchwork" });
    startTask("pgw", "pgw-1", "patchwork"); // → in-progress
    expect(noteTask("pgw", "pgw-1", "patchwork", "still going")?.state).toBe("in-progress");
    completeTask("pgw", "pgw-1", "patchwork"); // → done
    expect(noteTask("pgw", "pgw-1", "patchwork", "post-mortem")?.state).toBe("done");
  });

  test("noteTask by the assignee on a BLOCKED card keeps it blocked — never auto-unblocks (kobo-54 guard)", () => {
    addTask({ company: "pgw", title: "t", by: "eq3", assignee: "patchwork" });
    blockTask("pgw", "pgw-1", "patchwork", { kind: "needs_input" });
    const n = noteTask("pgw", "pgw-1", "patchwork", "here's the answer");
    expect(n?.state).toBe("blocked"); // still blocked — advance only fires on todo
    expect(n?.block?.kind).toBe("needs_input"); // block metadata untouched
  });

  test("noteTask by the assignee on a REVIEW card keeps it in review (kobo-54 guard)", () => {
    addTask({ company: "pgw", title: "t", by: "eq3", assignee: "patchwork" });
    reviewTask("pgw", "pgw-1", "patchwork");
    expect(noteTask("pgw", "pgw-1", "patchwork", "addressed feedback")?.state).toBe("review");
  });

  test("done on a never-claimed card emits no spurious claim-release", () => {
    addTask({ company: "pgw", title: "t", by: "eq3" });
    completeTask("pgw", "pgw-1", "tony");
    expect(readWorklog("pgw").some((e) => e.kind === "claim-release")).toBe(false);
  });

  test("claim/complete on a missing id → null (no throw)", () => {
    expect(claimTask("pgw", "pgw-999", "x")).toBeNull();
    expect(completeTask("pgw", "pgw-999", "x")).toBeNull();
  });

  test("exclusive create claims an id atomically — a collision never overwrites", () => {
    const a: TaskRecord = { id: "pgw-7", title: "first", company: "pgw", state: "todo", by: "x", assignee: null, ts: 1 };
    const b: TaskRecord = { id: "pgw-7", title: "RACER", company: "pgw", state: "todo", by: "y", assignee: null, ts: 2 };
    expect(tryCreateTaskRecord(a)).toBe(true); // wins the id
    expect(tryCreateTaskRecord(b)).toBe(false); // EEXIST → reports collision
    expect(readTask("pgw", "pgw-7")!.title).toBe("first"); // loser did NOT clobber
  });

  test("burst of adds yields unique ids with no loss (race guard)", () => {
    const N = 25;
    const ids = new Set<string>();
    for (let i = 0; i < N; i++) ids.add(addTask({ company: "pgw", title: `t${i}`, by: "x" }).id);
    expect(ids.size).toBe(N); // every add got a distinct id
    expect(listTasks("pgw").length).toBe(N); // every card persisted — none overwritten
  });

  test("atomic write leaves no .tmp behind; listTasks newest-first", () => {
    addTask({ company: "pgw", title: "first", by: "x" });
    addTask({ company: "pgw", title: "second", by: "x" });
    const files = readdirSync(tasksDir("pgw"));
    expect(files.every((f) => f.endsWith(".json"))).toBe(true);
    const list = listTasks("pgw");
    expect(list[0].title).toBe("second"); // newest first
    // file content is valid JSON
    expect(() => JSON.parse(readFileSync(taskFilePath("pgw", "pgw-1"), "utf-8"))).not.toThrow();
  });
});

describe("archive (ADR 0002 P3 — done cards age off the board, never deleted)", () => {
  const DAY = 86_400_000;

  test("archiveTask MOVES the card to tasks/archive/ (not delete) + emits task-archived", () => {
    addTask({ company: "pgw", title: "old", by: "eq3" });
    const a = archiveTask("pgw", "pgw-1", "system");
    expect(a?.id).toBe("pgw-1");
    expect(existsSync(taskFilePath("pgw", "pgw-1"))).toBe(false); // gone from active
    expect(existsSync(archivedTaskFilePath("pgw", "pgw-1"))).toBe(true); // preserved in archive
    expect(readWorklog("pgw").some((e) => e.kind === "task-archived" && e.task === "pgw-1")).toBe(true);
  });

  test("archived cards drop off listTasks but show in listArchivedTasks", () => {
    addTask({ company: "pgw", title: "a", by: "x" });
    addTask({ company: "pgw", title: "b", by: "x" });
    archiveTask("pgw", "pgw-1", "system");
    expect(listTasks("pgw").map((t) => t.id)).toEqual(["pgw-2"]);
    expect(listArchivedTasks("pgw").map((t) => t.id)).toEqual(["pgw-1"]);
  });

  test("nextTaskId never reuses an archived id", () => {
    addTask({ company: "pgw", title: "a", by: "x" }); // pgw-1
    addTask({ company: "pgw", title: "b", by: "x" }); // pgw-2 (highest)
    archiveTask("pgw", "pgw-2", "system"); // archive the highest id
    expect(nextTaskId("pgw")).toBe("pgw-3"); // not pgw-2 again
  });

  test("isOnBoard: non-done always on board; done only within the window", () => {
    const now = 10 * DAY;
    const done = (updatedTs: number): TaskRecord => ({ id: "x", title: "t", company: "pgw", state: "done", by: "x", assignee: null, ts: 0, updatedTs });
    expect(isOnBoard({ ...done(0), state: "in-progress" }, 7, now)).toBe(true); // non-done always
    expect(isOnBoard(done(now - 3 * DAY), 7, now)).toBe(true); // recent done
    expect(isOnBoard(done(now - 8 * DAY), 7, now)).toBe(false); // aged-out done
  });

  test("archiveOldDone sweeps only done cards older than N days", () => {
    const now = 100 * DAY;
    // fresh done (kept), old done (swept), old in-progress (kept — not done)
    const fresh = addTask({ company: "pgw", title: "fresh", by: "x" });
    completeTask("pgw", fresh.id, "x"); // updatedTs ~ now-ish (Date.now during test)
    const old = addTask({ company: "pgw", title: "old", by: "x" });
    completeTask("pgw", old.id, "x");
    // backdate the "old" done card well past the window
    const rec = readTask("pgw", old.id)!;
    rec.updatedTs = now - 30 * DAY;
    require("fs").writeFileSync(taskFilePath("pgw", old.id), JSON.stringify(rec));
    addTask({ company: "pgw", title: "wip", by: "x", assignee: "y", state: "in-progress" });

    const archived = archiveOldDone("pgw", 7, "system", now);
    expect(archived.map((t) => t.id)).toEqual([old.id]); // only the old done one
    expect(listArchivedTasks("pgw").map((t) => t.id)).toEqual([old.id]);
    expect(listTasks("pgw").some((t) => t.id === old.id)).toBe(false);
    expect(listTasks("pgw").some((t) => t.title === "wip")).toBe(true); // in-progress untouched
  });

  test("DEFAULT_ARCHIVE_DAYS is 7", () => {
    expect(DEFAULT_ARCHIVE_DAYS).toBe(7);
    expect(archiveDir("pgw").endsWith("/tasks/archive")).toBe(true);
  });

  test("isOnBoard: rejected is terminal too — windowed like done (kobo-101)", () => {
    const now = 10 * DAY;
    const rej = (updatedTs: number): TaskRecord => ({ id: "x", title: "t", company: "pgw", state: "rejected", by: "x", assignee: null, ts: 0, updatedTs });
    expect(isOnBoard(rej(now - 3 * DAY), 7, now)).toBe(true);  // recent rejected shown (learn)
    expect(isOnBoard(rej(now - 8 * DAY), 7, now)).toBe(false); // aged-out rejected sweeps
  });

  test("archiveOldDone sweeps old rejected cards too (kobo-101)", () => {
    const now = 100 * DAY;
    const r = addTask({ company: "pgw", title: "not accepted", by: "x", assignee: "y", state: "in-progress" });
    rejectTask("pgw", r.id, "tony", "scope creep");
    const rec = readTask("pgw", r.id)!;
    rec.updatedTs = now - 30 * DAY; // backdate past the window
    require("fs").writeFileSync(taskFilePath("pgw", r.id), JSON.stringify(rec));
    const archived = archiveOldDone("pgw", 7, "system", now);
    expect(archived.map((t) => t.id)).toEqual([r.id]);
    expect(listArchivedTasks("pgw").map((t) => t.id)).toContain(r.id);
  });
});

describe("reject (kobo-101 — terminal 'done but not accepted', parallel to done)", () => {
  test("reject from a non-terminal state sets state=rejected + stores the reason", () => {
    const t = addTask({ company: "pgw", title: "over-scoped plan", by: "eq3", assignee: "patchwork", state: "in-progress" });
    const r = rejectTask("pgw", t.id, "tony", "เกิน scope — ไม่เอา");
    expect(r?.state).toBe("rejected");
    expect(r?.rejectReason).toBe("เกิน scope — ไม่เอา");
    expect(readTask("pgw", t.id)?.state).toBe("rejected");
    // emits a task-rejected worklog event
    expect(readWorklog("pgw").some((e) => e.kind === "task-rejected" && e.task === t.id)).toBe(true);
  });

  test("reject is allowed from todo / review / blocked (any non-terminal)", () => {
    for (const state of ["todo", "review", "blocked"] as const) {
      const t = addTask({ company: "pgw", title: state, by: "eq3", assignee: "patchwork", state });
      expect(rejectTask("pgw", t.id, "tony", "no")?.state).toBe("rejected");
    }
  });

  test("reject releases the doer's open claim (board-truth — no stale claim)", () => {
    const t = addTask({ company: "pgw", title: "claimed", by: "eq3" });
    claimTask("pgw", t.id, "patchwork"); // opens a claim
    rejectTask("pgw", t.id, "tony", "not needed");
    expect(readWorklog("pgw").some((e) => e.kind === "claim-release" && e.task === t.id)).toBe(true);
  });

  test("a done or already-rejected card is terminal — reject is a no-op returning null", () => {
    const d = addTask({ company: "pgw", title: "shipped", by: "eq3" });
    completeTask("pgw", d.id, "x");
    expect(rejectTask("pgw", d.id, "tony", "too late")).toBeNull(); // done stays done
    expect(readTask("pgw", d.id)?.state).toBe("done");

    const r = addTask({ company: "pgw", title: "already rejected", by: "eq3" });
    rejectTask("pgw", r.id, "tony", "no");
    expect(rejectTask("pgw", r.id, "tony", "again")?.rejectReason).toBeUndefined(); // null → no re-reject
    expect(readTask("pgw", r.id)?.rejectReason).toBe("no"); // original reason untouched
  });

  test("missing card → null (not a throw)", () => {
    expect(rejectTask("pgw", "pgw-999", "tony", "x")).toBeNull();
  });
});

describe("dependency graph (ADR 0003 A — derived blocked-by-dependency, 1 hop)", () => {
  test("addTask stores parentIds (deduped); omits the field when none given", () => {
    const child = addTask({ company: "pgw", title: "child", by: "eq3", parentIds: ["pgw-1", "pgw-1", "pgw-2"] });
    expect(child.parentIds).toEqual(["pgw-1", "pgw-2"]); // deduped
    const plain = addTask({ company: "pgw", title: "plain", by: "eq3", parentIds: [] });
    expect(plain.parentIds).toBeUndefined(); // empty → not written
    expect(addTask({ company: "pgw", title: "none", by: "eq3" }).parentIds).toBeUndefined();
  });

  const child = (parentIds: string[]): TaskRecord => ({
    id: "c", title: "t", company: "pgw", state: "todo", by: "x", assignee: null, ts: 1, parentIds,
  });

  test("dependencyBlock: pending parent blocks; done/archived satisfy; missing warns (not block)", () => {
    const states: Record<string, ParentState> = { p1: "in-progress", p2: "done", p3: "archived", p4: null };
    const resolve = (id: string) => states[id] ?? null;
    const r = dependencyBlock(child(["p1", "p2", "p3", "p4"]), resolve);
    expect(r.blockedBy).toEqual(["p1"]); // only the not-done active parent blocks
    expect(r.missing).toEqual(["p4"]); // unknown id → satisfied + surfaced
  });

  test("isBlockedByDependency: true while any parent pending, false once all satisfied", () => {
    expect(isBlockedByDependency(child(["p1"]), () => "review")).toBe(true);
    expect(isBlockedByDependency(child(["p1"]), () => "done")).toBe(false);
    expect(isBlockedByDependency(child(["p1"]), () => "archived")).toBe(false);
    expect(isBlockedByDependency(child(["p1"]), () => null)).toBe(false); // missing ≠ blocked
    expect(isBlockedByDependency(child([]), () => "todo")).toBe(false); // no parents
  });

  test("no traversal — only the direct parent's state matters (loop-safe)", () => {
    // even if a parent itself had parents, dependencyBlock never looks past 1 hop
    const resolve = (id: string): ParentState => (id === "p1" ? "done" : "in-progress");
    expect(dependencyBlock(child(["p1"]), resolve).blockedBy).toEqual([]); // p1 done → satisfied, stop
  });

  test("parentStateResolver: active state, archived, or null", () => {
    addTask({ company: "pgw", title: "parent-active", by: "x" }); // pgw-1 (todo)
    const doneP = addTask({ company: "pgw", title: "parent-done", by: "x" }); // pgw-2
    completeTask("pgw", doneP.id, "x");
    const arch = addTask({ company: "pgw", title: "parent-arch", by: "x" }); // pgw-3
    completeTask("pgw", arch.id, "x");
    archiveTask("pgw", arch.id, "x");
    const resolve = parentStateResolver("pgw");
    expect(resolve("pgw-1")).toBe("todo");
    expect(resolve("pgw-2")).toBe("done");
    expect(resolve("pgw-3")).toBe("archived");
    expect(resolve("pgw-999")).toBeNull();
  });

  test("end-to-end: child unblocks once its parent is done (recomputed each read)", () => {
    const parent = addTask({ company: "pgw", title: "parent", by: "x" });
    addTask({ company: "pgw", title: "child", by: "x", parentIds: [parent.id] });
    const blockedNow = isBlockedByDependency(readTask("pgw", "pgw-2")!, parentStateResolver("pgw"));
    expect(blockedNow).toBe(true); // parent still todo
    completeTask("pgw", parent.id, "x");
    const blockedAfter = isBlockedByDependency(readTask("pgw", "pgw-2")!, parentStateResolver("pgw"));
    expect(blockedAfter).toBe(false); // parent done → child free (and auto-promoted to ready, kobo-133)
  });
});

describe("ready state + auto-promote (kobo-133 — Hermes-style: state machine, not view)", () => {
  test("completeTask promotes a dependent todo card to ready + emits task-updated", () => {
    const parent = addTask({ company: "pgw", title: "parent", by: "x" });
    const child = addTask({ company: "pgw", title: "child", by: "x", assignee: "patchwork", parentIds: [parent.id] });
    expect(readTask("pgw", child.id)!.state).toBe("todo"); // gated while parent pending
    completeTask("pgw", parent.id, "x");
    expect(readTask("pgw", child.id)!.state).toBe("ready");
    const wl = readWorklog("pgw");
    expect(wl.some((e) => e.kind === "task-updated" && e.task === child.id && /ready/.test(e.summary))).toBe(true);
  });

  test("multi-parent: promotes only when the LAST pending parent closes", () => {
    const p1 = addTask({ company: "pgw", title: "p1", by: "x" });
    const p2 = addTask({ company: "pgw", title: "p2", by: "x" });
    const child = addTask({ company: "pgw", title: "child", by: "x", parentIds: [p1.id, p2.id] });
    completeTask("pgw", p1.id, "x");
    expect(readTask("pgw", child.id)!.state).toBe("todo"); // p2 still pending
    completeTask("pgw", p2.id, "x");
    expect(readTask("pgw", child.id)!.state).toBe("ready");
  });

  test("only todo cards promote — in-progress/backlog/dep-less cards keep their lane", () => {
    const parent = addTask({ company: "pgw", title: "parent", by: "x" });
    const working = addTask({ company: "pgw", title: "working", by: "x", parentIds: [parent.id], state: "in-progress" });
    const parked = addTask({ company: "pgw", title: "parked", by: "x", parentIds: [parent.id], state: "backlog" });
    const plain = addTask({ company: "pgw", title: "plain", by: "x" }); // no deps at all
    completeTask("pgw", parent.id, "x");
    expect(readTask("pgw", working.id)!.state).toBe("in-progress");
    expect(readTask("pgw", parked.id)!.state).toBe("backlog");
    expect(readTask("pgw", plain.id)!.state).toBe("todo");
  });

  test("archiveTask satisfies deps too (same as done)", () => {
    const parent = addTask({ company: "pgw", title: "parent", by: "x" });
    const child = addTask({ company: "pgw", title: "child", by: "x", parentIds: [parent.id] });
    archiveTask("pgw", parent.id, "x"); // archived straight from todo
    expect(readTask("pgw", child.id)!.state).toBe("ready");
  });

  test("born ready: adding a todo card whose deps are ALL already done skips the todo lane", () => {
    const parent = addTask({ company: "pgw", title: "parent", by: "x" });
    completeTask("pgw", parent.id, "x"); // done BEFORE the child exists → no future promote event
    const child = addTask({ company: "pgw", title: "child", by: "x", parentIds: [parent.id] });
    expect(child.state).toBe("ready");
    // explicit backlog is respected — born-ready only upgrades the todo default
    const parked = addTask({ company: "pgw", title: "parked", by: "x", parentIds: [parent.id], state: "backlog" });
    expect(parked.state).toBe("backlog");
  });

  test("ready behaves like todo for pickup: needsOwner / nextAction / note auto-advance / start", () => {
    const parent = addTask({ company: "pgw", title: "parent", by: "x" });
    const child = addTask({ company: "pgw", title: "child", by: "x", assignee: "patchwork", parentIds: [parent.id] });
    completeTask("pgw", parent.id, "x");
    const ready = readTask("pgw", child.id)!;
    expect(needsOwner(ready)).toBe(false); // has an owner
    expect(needsOwner({ ...ready, assignee: null })).toBe(true); // unassigned ready = needs owner (rule 5)
    expect(taskNextAction(ready)).toContain("patchwork");
    // assignee note on a ready card = working it → in-progress (kobo-54 gate extended)
    noteTask("pgw", child.id, "patchwork", "on it");
    expect(readTask("pgw", child.id)!.state).toBe("in-progress");
  });

  test("moveTask can park a ready card back (human override) and re-file to ready", () => {
    const parent = addTask({ company: "pgw", title: "parent", by: "x" });
    const child = addTask({ company: "pgw", title: "child", by: "x", parentIds: [parent.id] });
    completeTask("pgw", parent.id, "x");
    moveTask("pgw", child.id, "backlog", "tony");
    expect(readTask("pgw", child.id)!.state).toBe("backlog");
    moveTask("pgw", child.id, "ready", "tony");
    expect(readTask("pgw", child.id)!.state).toBe("ready");
  });
});

describe("dep verbs (kobo-134 — setTaskDep edits parentIds after create)", () => {
  test("add links a dep; rm unlinks; field dropped when the last dep goes", () => {
    const p = addTask({ company: "pgw", title: "parent", by: "x" });
    const c = addTask({ company: "pgw", title: "child", by: "x" });
    expect(setTaskDep("pgw", c.id, p.id, "add", "x")!.parentIds).toEqual([p.id]);
    expect(isBlockedByDependency(readTask("pgw", c.id)!, parentStateResolver("pgw"))).toBe(true); // derived kicks in
    expect(setTaskDep("pgw", c.id, p.id, "rm", "x")!.parentIds).toBeUndefined(); // last dep → field dropped
    expect(isBlockedByDependency(readTask("pgw", c.id)!, parentStateResolver("pgw"))).toBe(false);
  });

  test("idempotent both ways: re-add keeps one link, rm of an absent link is a no-op", () => {
    const p = addTask({ company: "pgw", title: "parent", by: "x" });
    const c = addTask({ company: "pgw", title: "child", by: "x", parentIds: [p.id] });
    expect(setTaskDep("pgw", c.id, p.id, "add", "x")!.parentIds).toEqual([p.id]); // no dupe
    expect(setTaskDep("pgw", c.id, "pgw-ghost", "rm", "x")!.parentIds).toEqual([p.id]); // unchanged
  });

  test("guards: self-dep, containment-conflict (epic), and a dep cycle all throw", () => {
    const epic = addTask({ company: "pgw", title: "epic", by: "x", kind: "epic" });
    const a = addTask({ company: "pgw", title: "a", by: "x", epic: epic.id });
    const b = addTask({ company: "pgw", title: "b", by: "x", parentIds: [a.id] }); // b waits for a
    expect(() => setTaskDep("pgw", a.id, a.id, "add", "x")).toThrow(/itself/);
    expect(() => setTaskDep("pgw", a.id, epic.id, "add", "x")).toThrow(/containment/);
    expect(() => setTaskDep("pgw", a.id, b.id, "add", "x")).toThrow(/loop/i); // a→b + b→a = deadlock
  });

  test("unresolvable parent id still links (backward-compat, board warns); missing card → null", () => {
    const c = addTask({ company: "pgw", title: "child", by: "x" });
    expect(setTaskDep("pgw", c.id, "pgw-ghost", "add", "x")!.parentIds).toEqual(["pgw-ghost"]);
    expect(setTaskDep("pgw", "pgw-999", "pgw-1", "add", "x")).toBeNull();
  });

  test("createsDepLoop walks the parentIds graph transitively; visited set survives an upstream cycle", () => {
    const parents: Record<string, string[]> = { b: ["c"], c: ["d"], d: [], x: ["y"], y: ["x"] };
    const get = (id: string) => parents[id] ?? [];
    expect(createsDepLoop("d", "b", get)).toBe(true); // d ← b→c→d transitive
    expect(createsDepLoop("a", "b", get)).toBe(false); // a unreachable from b
    expect(createsDepLoop("a", "x", get)).toBe(false); // pre-existing x↔y cycle terminates, not a's loop
  });
});

describe("body + checklist (ADR 0003 C — markdown checkbox progress)", () => {
  test("addTask stores a non-empty body; omits when empty/absent", () => {
    const t = addTask({ company: "pgw", title: "x", by: "eq3", body: "why: ship it\n- [ ] a\n- [x] b" });
    expect(t.body).toContain("- [x] b");
    expect(readTask("pgw", t.id)!.body).toBe(t.body); // persisted
    expect(addTask({ company: "pgw", title: "y", by: "eq3", body: "" }).body).toBeUndefined();
    expect(addTask({ company: "pgw", title: "z", by: "eq3" }).body).toBeUndefined();
  });

  test("checklistProgress counts checked/total; null when no body or no checkbox", () => {
    expect(checklistProgress("- [ ] a\n- [x] b\n- [X] c")).toEqual({ done: 2, total: 3 });
    expect(checklistProgress("just prose, no boxes")).toBeNull();
    expect(checklistProgress("")).toBeNull();
    expect(checklistProgress(undefined)).toBeNull();
  });

  test("counts only real checkbox lines — bullets, indentation, ignores prose + inline brackets", () => {
    const body = [
      "# plan",
      "intro line [x] not a checkbox (no bullet)",
      "- [ ] top todo",
      "  * [x] indented star done",
      "    - [ ] deeper todo",
      "- regular bullet, not a checkbox",
      "- [z] not a valid mark",
    ].join("\n");
    expect(checklistProgress(body)).toEqual({ done: 1, total: 3 });
  });
});

describe("explicit block / unblock (ADR 0003 B — off-flow, remembers prevState)", () => {
  test("BLOCK_KINDS = the 4 Hermes kinds", () => {
    expect(BLOCK_KINDS).toEqual(["dependency", "needs_input", "capability", "transient"]);
  });

  test("blockTask: → blocked, stores prevState + block, emits task-blocked", () => {
    const t = addTask({ company: "pgw", title: "x", by: "eq3", assignee: "patchwork", state: "in-progress" });
    const b = blockTask("pgw", t.id, "eq3", { kind: "needs_input", reason: "merge?", for: "tony" })!;
    expect(b.state).toBe("blocked");
    expect(b.prevState).toBe("in-progress"); // remembers where to return
    expect(b.block).toEqual({ kind: "needs_input", reason: "merge?", for: "tony" });
    expect(b.assignee).toBe("patchwork"); // `for` is separate from assignee — owner unchanged
    expect(readWorklog("pgw").some((e) => e.kind === "task-blocked" && e.task === t.id)).toBe(true);
  });

  test("re-block keeps the ORIGINAL prevState (doesn't capture 'blocked')", () => {
    const t = addTask({ company: "pgw", title: "x", by: "eq3" }); // todo
    blockTask("pgw", t.id, "eq3", { kind: "needs_input" });
    blockTask("pgw", t.id, "eq3", { kind: "capability" }); // re-block
    expect(readTask("pgw", t.id)!.prevState).toBe("todo"); // not "blocked"
  });

  test("unblockTask: restores prevState, clears block + prevState, emits task-unblocked", () => {
    const t = addTask({ company: "pgw", title: "x", by: "eq3", assignee: "p", state: "in-progress" });
    blockTask("pgw", t.id, "eq3", { kind: "transient" });
    const u = unblockTask("pgw", t.id, "eq3")!;
    expect(u.state).toBe("in-progress"); // back to the flow state
    expect(u.block).toBeUndefined();
    expect(u.prevState).toBeUndefined();
    expect(readWorklog("pgw").some((e) => e.kind === "task-unblocked" && e.task === t.id)).toBe(true);
  });

  test("unblock with no prevState falls back to todo (never strands off-flow)", () => {
    const t = addTask({ company: "pgw", title: "x", by: "eq3" });
    const rec = readTask("pgw", t.id)!;
    rec.state = "blocked"; rec.block = { kind: "needs_input" }; // hand-crafted, no prevState
    require("fs").writeFileSync(taskFilePath("pgw", t.id), JSON.stringify(rec));
    expect(unblockTask("pgw", t.id, "eq3")!.state).toBe("todo");
  });

  test("done auto-clears an explicit block (+ prevState)", () => {
    const t = addTask({ company: "pgw", title: "x", by: "eq3" });
    blockTask("pgw", t.id, "eq3", { kind: "needs_input", for: "tony" });
    const d = completeTask("pgw", t.id, "tony")!;
    expect(d.state).toBe("done");
    expect(d.block).toBeUndefined();
    expect(d.prevState).toBeUndefined();
  });

  test("block / unblock on a missing id → null (no throw)", () => {
    expect(blockTask("pgw", "pgw-999", "x", { kind: "transient" })).toBeNull();
    expect(unblockTask("pgw", "pgw-999", "x")).toBeNull();
  });

  test("blockNextAction renders kind + who-clears + why", () => {
    expect(blockNextAction({ state: "blocked", block: { kind: "needs_input", for: "tony", reason: "ok?" } } as TaskRecord)).toBe("⚑ [needs_input] รอ tony: ok?");
    expect(blockNextAction({ state: "blocked", block: { kind: "capability" } } as TaskRecord)).toBe("⚑ [capability]");
  });
});

describe("pr-link repo binding (kobo-80 — enforce/backfill card.repo so pr-watch can flip)", () => {
  test("parsePrRepo extracts owner/repo from a PR url; ignores a bare number", () => {
    expect(parsePrRepo("https://github.com/meganechan/maw-js/pull/106")).toBe("meganechan/maw-js");
    expect(parsePrRepo("106")).toBeUndefined();
    expect(parsePrRepo("see meganechan/maw-js#106")).toBeUndefined(); // not a /pull/ url
  });

  test("setTaskPr fills a MISSING repo but never overwrites an existing one", () => {
    const a = addTask({ company: "pgw", title: "no repo", by: "eq3" });
    expect(setTaskPr("pgw", a.id, 1, "patchwork", "meganechan/maw-js")!.repo).toBe("meganechan/maw-js");
    const b = addTask({ company: "pgw", title: "has repo", by: "eq3", repo: "acme/keep" });
    expect(setTaskPr("pgw", b.id, 2, "patchwork", "other/nope")!.repo).toBe("acme/keep"); // existing wins
    const c = addTask({ company: "pgw", title: "no arg", by: "eq3" });
    expect(setTaskPr("pgw", c.id, 3, "patchwork")!.repo).toBeUndefined(); // no repo passed → still none
  });

  test("setTaskRepoIfMissing backfills only when absent; no-op (no write) otherwise", () => {
    const a = addTask({ company: "pgw", title: "heal me", by: "eq3" });
    expect(setTaskRepoIfMissing("pgw", a.id, "meganechan/maw-js")!.repo).toBe("meganechan/maw-js");
    const b = addTask({ company: "pgw", title: "keep mine", by: "eq3", repo: "acme/keep" });
    const before = readTask("pgw", b.id)!.updatedTs;
    expect(setTaskRepoIfMissing("pgw", b.id, "other/nope")!.repo).toBe("acme/keep"); // unchanged
    expect(readTask("pgw", b.id)!.updatedTs).toBe(before); // no-op → no write
    expect(setTaskRepoIfMissing("pgw", "pgw-nope", "x/y")).toBeNull(); // absent card
  });
});

describe("prOpenedReview (eq3-011 kobo-13 — PR open drives the linked card to review + owner)", () => {
  test("linked card → review, assignee=author, reviewer=creator (kobo-144 addendum) + emits task-review", () => {
    const t = addTask({ company: "pgw", title: "ship it", by: "eq3" }); // todo, unassigned
    setTaskPr("pgw", t.id, 77, "patchwork"); // worker attaches PR at open (the card.pr link)
    const r = prOpenedReview("pgw", t.id, "patchwork")!;
    expect(r.state).toBe("review");
    expect(r.assignee).toBe("patchwork"); // owner = PR author
    expect(r.reviewer).toBe("eq3"); // kobo-144: creator (who wrote the AC) reviews, not hardcoded human
    expect(readWorklog("pgw").some((e) => e.kind === "task-review" && e.task === t.id)).toBe(true);
  });

  test("creator IS the PR author → self-review banned → reviewer=human (kobo-144 addendum)", () => {
    const t = addTask({ company: "pgw", title: "solo card", by: "patchwork" }); // creator = the doer
    const r = prOpenedReview("pgw", t.id, "patchwork")!; // same person opens the PR
    expect(r.reviewer).toBe("human"); // can't review own work → falls through to the human
  });

  test("explicit reviewer field wins over the creator default (kobo-144)", () => {
    const t = addTask({ company: "pgw", title: "pinned reviewer", by: "eq3", reviewer: "somsri" });
    const r = prOpenedReview("pgw", t.id, "patchwork")!;
    expect(r.reviewer).toBe("somsri"); // the card named its reviewer → kept on the PR-open flip
  });

  test("idempotent — re-run leaves the card exactly as-is (PR-watch re-polls don't churn)", () => {
    const t = addTask({ company: "pgw", title: "x", by: "eq3" });
    prOpenedReview("pgw", t.id, "patchwork");
    const before = readTask("pgw", t.id)!.updatedTs;
    const again = prOpenedReview("pgw", t.id, "patchwork")!;
    expect(again.updatedTs).toBe(before); // no write on the idempotent no-op
  });

  test("never resurrects a done card", () => {
    const t = addTask({ company: "pgw", title: "x", by: "eq3" });
    completeTask("pgw", t.id, "tony");
    const r = prOpenedReview("pgw", t.id, "patchwork")!;
    expect(r.state).toBe("done"); // left closed
  });

  test("missing id → null (no throw)", () => {
    expect(prOpenedReview("pgw", "pgw-999", "x")).toBeNull();
  });
});

describe("resolveReviewer (kobo-144 — reviewer field → creator → human)", () => {
  const mk = (over: Partial<TaskRecord>): TaskRecord =>
    ({ id: "x", title: "t", company: "pgw", state: "review", by: "eq3", assignee: "patchwork", ts: 1, ...over });
  test("explicit reviewer field wins", () => expect(resolveReviewer(mk({ reviewer: "somsri" }))).toBe("somsri"));
  test("no field → creator, when creator ≠ doer", () => expect(resolveReviewer(mk({ by: "eq3", assignee: "patchwork" }))).toBe("eq3"));
  test("creator IS the doer → human (self-review banned)", () => expect(resolveReviewer(mk({ by: "patchwork", assignee: "patchwork" }))).toBe("human"));
  test("no assignee yet → creator still reviews", () => expect(resolveReviewer(mk({ by: "eq3", assignee: null }))).toBe("eq3"));
});

describe("holdTask (kobo-144 — reviewer's brake, any state → review)", () => {
  test("pulls an in-progress card into review with a reason, keeps reviewer chain", () => {
    const t = addTask({ company: "hold", title: "big schema change", by: "eq3", assignee: "patchwork", state: "todo" });
    startTask("hold", t.id, "patchwork"); // in-progress
    const held = holdTask("hold", t.id, "eq3", "schema change — needs a look")!;
    expect(held.state).toBe("review");
    expect(held.reviewReason).toBe("schema change — needs a look");
    expect(resolveReviewer(held)).toBe("eq3"); // creator reviews (no explicit field)
    expect(readWorklog("hold").some((e) => e.kind === "task-review" && e.task === t.id)).toBe(true);
  });
  test("default reason is 'held'; missing card → null", () => {
    const t = addTask({ company: "hold", title: "x", by: "eq3", assignee: "carol" });
    expect(holdTask("hold", t.id, "eq3")!.reviewReason).toBe("held");
    expect(holdTask("hold", "hold-999", "eq3")).toBeNull();
  });
});

describe("approveTask (kobo-191 — reviewer routes big-work review → approve, reason mandatory)", () => {
  test("moves a reviewed card to approve with the mandatory reason (Tony's queue)", () => {
    const t = addTask({ company: "app", title: "deploy migration", by: "eq3", assignee: "patchwork" });
    reviewTask("app", t.id, "patchwork"); // in review
    const a = approveTask("app", t.id, "eq3", "  live schema migration — Tony must decide  ")!;
    expect(a.state).toBe("approve");
    expect(a.reviewReason).toBe("live schema migration — Tony must decide"); // trimmed, persisted
    expect(readWorklog("app").some((e) => e.kind === "task-review" && e.task === t.id)).toBe(true);
  });
  test("empty/whitespace reason → null (no reason-less park); missing card → null", () => {
    const t = addTask({ company: "app", title: "x", by: "eq3", assignee: "patchwork" });
    expect(approveTask("app", t.id, "eq3", "")).toBeNull();
    expect(approveTask("app", t.id, "eq3", "   ")).toBeNull();
    expect(readTask("app", t.id)!.state).not.toBe("approve"); // never parked without a reason
    expect(approveTask("app", "app-999", "eq3", "why")).toBeNull();
  });
});

describe("reviewTask persists the reviewer field (kobo-144 — plain review keeps it)", () => {
  test("a card with a persistent reviewer keeps it through a plain review (no --to)", () => {
    const t = addTask({ company: "rev", title: "t", by: "eq3", assignee: "patchwork", reviewer: "somsri" });
    const r = reviewTask("rev", t.id, "patchwork")!; // no opts.to
    expect(r.reviewer).toBe("somsri"); // NOT cleared — the field survives
  });
  test("--to overrides the reviewer field", () => {
    const t = addTask({ company: "rev", title: "t2", by: "eq3", assignee: "patchwork", reviewer: "somsri" });
    const r = reviewTask("rev", t.id, "patchwork", { to: "nao" })!;
    expect(r.reviewer).toBe("nao");
  });
});

describe("decomposeEpic (kobo-146 C7 — plan → child cards + links, option B)", () => {
  const mkEpic = () => addTask({ company: "dec", title: "epic", by: "eq3" });

  test("creates children under the epic, links sibling deps ($N), passes body/reviewer", () => {
    const epic = mkEpic();
    const r = decomposeEpic("dec", epic.id, [
      { title: "a", body: "AC: given/when/then" },
      { title: "b", deps: ["$0"] },
      { title: "c", deps: ["$0", "$1"], reviewer: "somsri" },
    ], "eq3");
    expect(r.created.map((c) => c.title)).toEqual(["a", "b", "c"]);
    expect(r.failed).toBeUndefined();
    const kids = Object.fromEntries(epicChildren(epic.id, listTasks("dec")).map((k) => [k.title, k]));
    expect(kids.a.epic).toBe(epic.id);
    expect(kids.a.body).toBe("AC: given/when/then");
    expect(kids.b.parentIds).toEqual([kids.a.id]); // $0 → a
    expect(kids.c.parentIds).toEqual([kids.a.id, kids.b.id]); // $0,$1 → a,b
    expect(kids.c.reviewer).toBe("somsri");
    // parent promoted to an epic container
    expect(readTask("dec", epic.id)!.kind).toBe("epic");
  });

  test("idempotent — a title that already exists under the epic is skipped, its id still resolves $N", () => {
    const epic = mkEpic();
    decomposeEpic("dec", epic.id, [{ title: "a" }], "eq3");
    const r = decomposeEpic("dec", epic.id, [{ title: "a" }, { title: "b", deps: ["$0"] }], "eq3");
    expect(r.created.map((c) => c.title)).toEqual(["b"]);
    expect(r.skipped.map((c) => c.title)).toEqual(["a"]);
    const kids = Object.fromEntries(epicChildren(epic.id, listTasks("dec")).map((k) => [k.title, k]));
    expect(kids.b.parentIds).toEqual([kids.a.id]); // $0 resolved to the pre-existing a
  });

  test("unhappy path — a child throws → stop, report what landed (never silent)", () => {
    const epic = mkEpic();
    const r = decomposeEpic("dec", epic.id, [{ title: "ok" }, { title: "  " }, { title: "never" }], "eq3");
    expect(r.created.map((c) => c.title)).toEqual(["ok"]);
    expect(r.failed).toEqual({ index: 1, title: "  ", error: "child title is required" });
    expect(epicChildren(epic.id, listTasks("dec")).find((k) => k.title === "never")).toBeUndefined();
  });

  test("a dep cycle / bad $N ref becomes a depWarning — cards still created", () => {
    const epic = mkEpic();
    const r = decomposeEpic("dec", epic.id, [
      { title: "x", deps: ["$5"] }, // out of range
      { title: "y", deps: ["$1"] }, // self-ref → dep loop
    ], "eq3");
    expect(r.created).toHaveLength(2);
    expect(r.depWarnings.length).toBeGreaterThanOrEqual(2);
  });

  test("missing epic → throws", () => {
    expect(() => decomposeEpic("dec", "dec-999", [{ title: "a" }], "eq3")).toThrow(/epic not found/);
  });
});

describe("needs-owner block (eq3-011 kobo-14 — derived, todo+unassigned off-flow)", () => {
  const mk = (over: Partial<TaskRecord>): TaskRecord =>
    ({ id: "x", title: "t", company: "pgw", state: "todo", by: "eq3", assignee: null, ts: 1, ...over });

  test("needsOwner: only todo + unassigned; auto-clears when assigned; backlog/other states exempt", () => {
    expect(needsOwner(mk({ state: "todo", assignee: null }))).toBe(true);
    expect(needsOwner(mk({ state: "todo", assignee: "patchwork" }))).toBe(false); // has an owner
    expect(needsOwner(mk({ state: "backlog", assignee: null }))).toBe(false); // backlog exempt (not ready)
    expect(needsOwner(mk({ state: "in-progress", assignee: null }))).toBe(false); // its own flow
    expect(needsOwner(mk({ state: "done", assignee: null }))).toBe(false);
  });

  test("assigning an owner flips it off (derived, no stored flag)", () => {
    const t = addTask({ company: "pgw", title: "orphan", by: "eq3" }); // todo, unassigned
    expect(needsOwner(readTask("pgw", t.id)!)).toBe(true);
    startTask("pgw", t.id, "patchwork"); // now owned + in-progress
    expect(needsOwner(readTask("pgw", t.id)!)).toBe(false);
  });

  test("taskNextAction — assigned todo says 'รอ <assignee> เริ่ม'; unassigned flags no-owner (side-bug fix)", () => {
    expect(taskNextAction(mk({ state: "todo", assignee: "patchwork" }))).toBe("รอ patchwork เริ่ม");
    expect(taskNextAction(mk({ state: "todo", assignee: null }))).toContain("ยังไม่มีเจ้าของ");
  });
});

describe("containment / epic (kobo-45)", () => {
  // helper: make an epic + N children under it, return their ids
  const family = () => {
    const epic = addTask({ company: "pgw", title: "epic root", by: "eq3", kind: "epic" });
    const a = addTask({ company: "pgw", title: "child a", by: "eq3", epic: epic.id });
    const b = addTask({ company: "pgw", title: "child b", by: "eq3", epic: epic.id });
    return { epic: epic.id, a: a.id, b: b.id };
  };

  test("kind:epic + epic parent id persist; a plain task stores neither", () => {
    const { epic, a } = family();
    expect(readTask("pgw", epic)!.kind).toBe("epic");
    expect(readTask("pgw", a)!.epic).toBe(epic);
    expect(readTask("pgw", a)!.kind).toBeUndefined(); // default task not persisted
    // parentIds (deps) is a separate axis — untouched by containment
    expect(readTask("pgw", a)!.parentIds).toBeUndefined();
  });

  test("epicChildren / openEpicChildren derive containment (epic ≠ parentIds)", () => {
    const { epic, a, b } = family();
    const cards = listTasks("pgw");
    expect(epicChildren(epic, cards).map((c) => c.id).sort()).toEqual([a, b].sort());
    expect(openEpicChildren(epic, cards).length).toBe(2); // both open
    completeTask("pgw", a, "eq3");
    expect(openEpicChildren(epic, listTasks("pgw")).map((c) => c.id)).toEqual([b]);
  });

  test("epicRollup = N/M done; allDone flips only when every child done (still no auto-close)", () => {
    const { epic, a, b } = family();
    expect(epicRollup(epic, listTasks("pgw"))).toEqual({ done: 0, total: 2, allDone: false });
    completeTask("pgw", a, "eq3");
    expect(epicRollup(epic, listTasks("pgw"))).toEqual({ done: 1, total: 2, allDone: false });
    completeTask("pgw", b, "eq3");
    expect(epicRollup(epic, listTasks("pgw"))).toEqual({ done: 2, total: 2, allDone: true });
    // allDone is a badge signal, NOT a state flip — epic stays open
    expect(readTask("pgw", epic)!.state).not.toBe("done");
  });

  test("epicRollup null for a card with no children (plain card, no badge)", () => {
    const t = addTask({ company: "pgw", title: "lonely", by: "eq3" });
    expect(epicRollup(t.id, listTasks("pgw"))).toBeNull();
  });

  test("createsEpicLoop: self, direct, and deep ancestor cycles are caught; a valid parent is not", () => {
    // chain g <- p <- c  (getEpic returns each card's parent)
    const parent: Record<string, string | undefined> = { c: "p", p: "g", g: undefined };
    const getEpic = (id: string) => parent[id];
    expect(createsEpicLoop("c", "c", getEpic)).toBe(true); // self
    expect(createsEpicLoop("g", "c", getEpic)).toBe(true); // g under c → g is c's ancestor → loop
    expect(createsEpicLoop("p", "c", getEpic)).toBe(true); // deep: p under c
    expect(createsEpicLoop("c", "g", getEpic)).toBe(false); // c under g is fine (already is)
    expect(createsEpicLoop("x", "g", getEpic)).toBe(false); // unrelated new child
  });

  test("setTaskEpic rejects a loop on write; accepts a valid reparent; clears with undefined", () => {
    const { epic, a, b } = family();
    // b under a is fine
    expect(setTaskEpic("pgw", b, a, "eq3")!.epic).toBe(a);
    // now epic <- a <- b ; making epic a child of b would loop → reject
    expect(() => setTaskEpic("pgw", epic, b, "eq3")).toThrow(/loop/i);
    expect(readTask("pgw", epic)!.epic).toBeUndefined(); // unchanged after reject
    // clear
    expect(setTaskEpic("pgw", a, undefined, "eq3")!.epic).toBeUndefined();
  });

  test("setTaskEpic to an unresolvable id is allowed (plain tag, backward-compat)", () => {
    const t = addTask({ company: "pgw", title: "orphan child", by: "eq3" });
    expect(setTaskEpic("pgw", t.id, "pgw-ghost", "eq3")!.epic).toBe("pgw-ghost");
    expect(resolveEpicParent("pgw-ghost", parentStateResolver("pgw")).resolved).toBe(false);
  });

  test("setTaskEpic re-links a same-id dependency onto containment; keeps other deps (kobo-72)", () => {
    const parent = addTask({ company: "pgw", title: "parent", by: "eq3" });
    const other = addTask({ company: "pgw", title: "other dep", by: "eq3" });
    // card wrongly used the DEPENDENCY axis for what should be containment (+ a real dep)
    const child = addTask({ company: "pgw", title: "child", by: "eq3", parentIds: [parent.id, other.id] });
    const t = setTaskEpic("pgw", child.id, parent.id, "eq3")!;
    expect(t.epic).toBe(parent.id);
    expect(t.parentIds).toEqual([other.id]); // stale same-id dep dropped, unrelated dep kept
    // sole-dep re-link removes parentIds entirely
    const solo = addTask({ company: "pgw", title: "solo", by: "eq3", parentIds: [parent.id] });
    expect(setTaskEpic("pgw", solo.id, parent.id, "eq3")!.parentIds).toBeUndefined();
  });

  test("guard a: archiving an epic with open children is BLOCKED + lists them", () => {
    const { epic, a, b } = family();
    let err: unknown;
    try { archiveTask("pgw", epic, "eq3"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(EpicArchiveBlockedError);
    expect((err as EpicArchiveBlockedError).activeChildren.sort()).toEqual([a, b].sort());
    expect(readTask("pgw", epic)).not.toBeNull(); // still on board — not moved
  });

  test("guard a: once all children done, the epic archives freely", () => {
    const { epic, a, b } = family();
    completeTask("pgw", a, "eq3");
    completeTask("pgw", b, "eq3");
    expect(() => archiveTask("pgw", epic, "eq3")).not.toThrow();
    expect(readTask("pgw", epic)).toBeNull(); // moved to archive
  });

  test("guard b: done epic with children incomplete is ALLOWED (store permits; caller confirms)", () => {
    const { epic, a } = family();
    completeTask("pgw", a, "eq3"); // b still open
    expect(completeTask("pgw", epic, "eq3")!.state).toBe("done"); // no block on close
    expect(openEpicChildren(epic, listTasks("pgw")).length).toBe(1); // b still open, surfaced
  });

  test("guard c: an archived parent resolves to a chip (archived), never a block", () => {
    const { epic, a, b } = family();
    completeTask("pgw", a, "eq3");
    completeTask("pgw", b, "eq3");
    archiveTask("pgw", epic, "eq3"); // now archived
    const child = addTask({ company: "pgw", title: "late child", by: "eq3", epic });
    const ref = resolveEpicParent(child.epic!, parentStateResolver("pgw"));
    expect(ref.archived).toBe(true);
    expect(ref.resolved).toBe(true);
  });

  test("aging sweep keeps a done epic on-board while a child is still open (no orphaning)", () => {
    const { epic, a, b } = family();
    completeTask("pgw", a, "eq3");
    completeTask("pgw", epic, "eq3"); // epic done but b still open
    const long_ago = Date.now() + DEFAULT_ARCHIVE_DAYS * 86_400_000 + 1; // "now" far in the future
    const archived = archiveOldDone("pgw", DEFAULT_ARCHIVE_DAYS, "system", long_ago);
    expect(archived.map((t) => t.id)).toContain(a); // the leaf done child sweeps
    expect(archived.map((t) => t.id)).not.toContain(epic); // epic stays — b (open) still points to it
    expect(readTask("pgw", epic)).not.toBeNull();
  });
});

describe("family notes (kobo-46 — parent modal derived data)", () => {
  test("descendantCards walks the whole containment tree (epic→task→subtask)", () => {
    const epic = addTask({ company: "pgw", title: "epic", by: "eq3", kind: "epic" });
    const task = addTask({ company: "pgw", title: "task", by: "eq3", epic: epic.id });
    const sub = addTask({ company: "pgw", title: "subtask", by: "eq3", epic: task.id });
    const other = addTask({ company: "pgw", title: "unrelated", by: "eq3" });
    const cards = listTasks("pgw");
    const ids = descendantCards(epic.id, cards).map((c) => c.id).sort();
    expect(ids).toEqual([task.id, sub.id].sort()); // both levels, not `other`
    expect(descendantCards(epic.id, cards).map((c) => c.id)).not.toContain(other.id);
  });

  test("familyNotes merges descendant notes oldest-first, tagged by source; epic's OWN notes excluded", () => {
    const epic = addTask({ company: "pgw", title: "epic", by: "eq3", kind: "epic" });
    const a = addTask({ company: "pgw", title: "a", by: "eq3", epic: epic.id });
    const b = addTask({ company: "pgw", title: "b", by: "eq3", epic: a.id }); // nested
    noteTask("pgw", epic.id, "tony", "epic own note"); // must NOT appear in familyNotes
    noteTask("pgw", a.id, "patchwork", "child a note");
    noteTask("pgw", b.id, "tony", "sub b note");
    const fam = familyNotes(epic.id, listTasks("pgw"));
    expect(fam.map((n) => n.from)).toEqual([a.id, b.id]); // oldest-first, tagged; epic's own excluded
    expect(fam.map((n) => n.text)).toEqual(["child a note", "sub b note"]);
  });

  test("familyNotes empty when no descendant has notes", () => {
    const epic = addTask({ company: "pgw", title: "epic", by: "eq3", kind: "epic" });
    addTask({ company: "pgw", title: "quiet child", by: "eq3", epic: epic.id });
    expect(familyNotes(epic.id, listTasks("pgw"))).toEqual([]);
  });
});

describe("backlog state (kobo-70)", () => {
  test("addTask --state backlog parks the card in backlog (default is todo)", () => {
    expect(addTask({ company: "pgw", title: "later", by: "eq3" }).state).toBe("todo");
    const b = addTask({ company: "pgw", title: "parked", by: "eq3", state: "backlog" });
    expect(b.state).toBe("backlog");
    expect(readTask("pgw", b.id)!.state).toBe("backlog");
  });

  test("moveTask re-files backlog ⇄ todo, emits a task-updated event, no assignee change", () => {
    const t = addTask({ company: "pgw", title: "roam", by: "eq3", assignee: "patchwork", state: "backlog" });
    const toTodo = moveTask("pgw", t.id, "todo", "eq3")!;
    expect(toTodo.state).toBe("todo");
    expect(toTodo.assignee).toBe("patchwork"); // move never touches ownership
    expect(moveTask("pgw", t.id, "backlog", "eq3")!.state).toBe("backlog");
    expect(readTask("pgw", t.id)!.state).toBe("backlog");
    expect(readWorklog("pgw").some((e) => e.kind === "task-updated" && e.task === t.id)).toBe(true);
    expect(moveTask("pgw", "pgw-999", "todo", "eq3")).toBeNull(); // absent
  });

  test("backlog is a parking lot — NEVER derives needs-owner (board-truth exempt)", () => {
    const b = addTask({ company: "pgw", title: "parked no owner", by: "eq3", state: "backlog" }); // unassigned
    expect(needsOwner(readTask("pgw", b.id)!)).toBe(false); // backlog exempt
    // for contrast: an unassigned TODO does need an owner
    expect(needsOwner(addTask({ company: "pgw", title: "todo no owner", by: "eq3" }))).toBe(true);
  });
});

describe("@mentions + ask (kobo-126)", () => {
  test("mentionKey collapses @tony/@human/tony/human to one canonical queue", () => {
    expect(mentionKey("@tony")).toBe("tony");
    expect(mentionKey("human")).toBe("tony");
    expect(mentionKey("HUMAN")).toBe("tony");
    expect(mentionKey("@patchwork")).toBe("patchwork"); // others pass through, lowercased
    expect(mentionKey("EQ3")).toBe("eq3");
  });

  test("parseMentions pulls distinct canonical @mentions out of a note", () => {
    expect(parseMentions("hey @tony and @human, ask @eq3 too @tony").sort()).toEqual(["eq3", "tony"]);
    expect(parseMentions("no mentions here")).toEqual([]);
  });

  test("askTask creates a subcard assigned to the answerer + parent-linked (one shot)", () => {
    const parent = addTask({ company: "pgw", title: "epic parent", by: "eq3", kind: "epic" });
    const q = askTask("pgw", parent.id, "ship X or Y?", "tony", "patchwork");
    expect(q).not.toBeNull();
    expect(q!.title).toBe("ship X or Y?");
    expect(q!.epic).toBe(parent.id); // containment link → subcard
    expect(q!.assignee).toBe("tony"); // answerer
    expect(q!.state).toBe("todo");
    // routed through addTask → persisted like any card (single write path)
    expect(readTask("pgw", q!.id)!.epic).toBe(parent.id);
  });

  test("askTask normalizes @human answerer to the tony queue + rejects missing parent", () => {
    const parent = addTask({ company: "pgw", title: "p", by: "eq3" });
    expect(askTask("pgw", parent.id, "q?", "human", "patchwork")!.assignee).toBe("tony");
    expect(askTask("pgw", "pgw-nope", "q?", "tony", "patchwork")).toBeNull(); // no parent → null
  });

  test("pendingMentions reads unresolved COMMENTS with @mentions and drops resolved ones (kobo-140 repoint)", () => {
    const a = addTask({ company: "pgw", title: "card A", by: "eq3" });
    commentTask("pgw", a.id, "eq3", "@tony rename to Foo?");
    const b = addTask({ company: "pgw", title: "card B", by: "eq3" });
    commentTask("pgw", b.id, "eq3", "@patchwork bump dep");

    const all = pendingMentions("pgw");
    expect(all.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    expect(all.every((m) => m.commentId === "c1")).toBe(true); // carries the resolve target
    // --for filters (and @human aliases to tony)
    expect(pendingMentions("pgw", "human").map((m) => m.id)).toEqual([a.id]);

    // resolving A's comment drops it from the queue (explicit resolve, not "noted after")
    resolveComment("pgw", a.id, "c1", "tony");
    expect(pendingMentions("pgw", "tony")).toEqual([]);
    expect(pendingMentions("pgw", "patchwork").map((m) => m.id)).toEqual([b.id]); // B still pending
  });

  test("pendingMentions ignores @mentions inside NOTES (notes are log/evidence, not asks — rule 10)", () => {
    const a = addTask({ company: "pgw", title: "card A", by: "eq3" });
    noteTask("pgw", a.id, "eq3", "log: pinged @tony out of band");
    expect(pendingMentions("pgw", "tony")).toEqual([]); // a note @ does NOT enter the queue
  });

  test("commentTask threads via replyTo, stamps stable c<n> ids, rejects a dangling reply", () => {
    const card = addTask({ company: "pgw", title: "card", by: "eq3", assignee: "patchwork" });
    const t1 = commentTask("pgw", card.id, "eq3", "@patchwork can you look?")!;
    expect(t1.comments![0].id).toBe("c1");
    expect(t1.comments![0].resolved).toBeUndefined();
    const t2 = commentTask("pgw", card.id, "patchwork", "on it", "c1")!;
    expect(t2.comments![1].id).toBe("c2");
    expect(t2.comments![1].replyTo).toBe("c1");
    // dangling reply target → throws (no orphan threads)
    expect(() => commentTask("pgw", card.id, "eq3", "x", "c99")).toThrow();
    // absent card → null (matches note/ask contract)
    expect(commentTask("pgw", "pgw-nope", "eq3", "x")).toBeNull();
  });

  test("resolveComment flips the flag once (idempotent, Principle 1: text kept), throws on a bad id", () => {
    const card = addTask({ company: "pgw", title: "card", by: "eq3" });
    commentTask("pgw", card.id, "eq3", "@tony ok?");
    const r = resolveComment("pgw", card.id, "c1", "tony")!;
    expect(r.comments![0].resolved).toBe(true);
    expect(r.comments![0].resolvedBy).toBe("tony");
    expect(r.comments![0].text).toBe("@tony ok?"); // text never removed
    // idempotent — resolving again keeps the original resolver
    resolveComment("pgw", card.id, "c1", "eq3");
    expect(readTask("pgw", card.id)!.comments![0].resolvedBy).toBe("tony");
    expect(() => resolveComment("pgw", card.id, "c99", "eq3")).toThrow();
    expect(resolveComment("pgw", "pgw-nope", "c1", "eq3")).toBeNull();
  });

  // kobo-142 (C3): migrate question-notes (notes with @mentions — the old ask
  // channel) into comments[] on ACTIVE cards. COPY (note kept), idempotent, and
  // already-answered questions migrate as resolved so the queue isn't resurfaced.
  test("migrateQuestionNotesToComments copies @-notes to comments (note kept), skips plain notes + done/rejected cards", () => {
    const a = addTask({ company: "pgw", title: "card A", by: "eq3", assignee: "patchwork" });
    noteTask("pgw", a.id, "eq3", "@tony rename to Foo?"); // question-note → migrates
    noteTask("pgw", a.id, "patchwork", "plain progress, no mention"); // stays a note only
    const done = addTask({ company: "pgw", title: "closed", by: "eq3", assignee: "patchwork" });
    noteTask("pgw", done.id, "eq3", "@tony old question");
    completeTask("pgw", done.id, "patchwork"); // done → untouched

    const res = migrateQuestionNotesToComments("pgw");
    expect(res.migrated).toBe(1); // only A's @-note
    expect(res.outcomes.find((o) => o.id === a.id)!.migrated).toBe(1);

    const ca = readTask("pgw", a.id)!;
    expect(ca.comments!.length).toBe(1);
    expect(ca.comments![0].text).toBe("@tony rename to Foo?");
    expect(ca.comments![0].fromNote).toBe(ca.notes![0].ts); // provenance marker
    expect(ca.comments![0].resolved).toBeUndefined(); // unanswered → open
    expect(ca.notes!.length).toBe(2); // both notes KEPT (dual-keep, nothing deleted)
    // the queue (repointed to comments) now surfaces the migrated question
    expect(pendingMentions("pgw", "tony").map((m) => m.id)).toEqual([a.id]);
    // done card never gained a comment
    expect(readTask("pgw", done.id)!.comments ?? []).toEqual([]);
  });

  test("migrateQuestionNotesToComments marks an ANSWERED question-note as resolved (queue not resurfaced)", () => {
    const b = addTask({ company: "pgw", title: "card B", by: "eq3" });
    noteTask("pgw", b.id, "eq3", "@tony ship X or Y?");
    noteTask("pgw", b.id, "tony", "Y please"); // tony replied later → answered

    migrateQuestionNotesToComments("pgw");
    const cb = readTask("pgw", b.id)!;
    expect(cb.comments![0].resolved).toBe(true);
    expect(cb.comments![0].resolvedBy).toBe("tony");
    expect(pendingMentions("pgw", "tony")).toEqual([]); // stays out of the queue
  });

  test("migrateQuestionNotesToComments is idempotent (fromNote marker) and dry-run writes nothing", () => {
    const a = addTask({ company: "pgw", title: "card A", by: "eq3" });
    noteTask("pgw", a.id, "eq3", "@tony ok?");

    const dry = migrateQuestionNotesToComments("pgw", { dryRun: true });
    expect(dry.migrated).toBe(1);
    expect(readTask("pgw", a.id)!.comments ?? []).toEqual([]); // dry-run: no write

    expect(migrateQuestionNotesToComments("pgw").migrated).toBe(1);
    const rerun = migrateQuestionNotesToComments("pgw");
    expect(rerun.migrated).toBe(0); // nothing new
    expect(rerun.skipped).toBe(1); // recognised as already migrated
    expect(readTask("pgw", a.id)!.comments!.length).toBe(1); // no duplicate

    // a native post-migration comment is never disturbed by a later re-run
    commentTask("pgw", a.id, "patchwork", "native");
    migrateQuestionNotesToComments("pgw");
    expect(readTask("pgw", a.id)!.comments!.length).toBe(2);
  });

  // kobo-135 (B3): completing an ask-subcard runs the parent-notify hook. The poke
  // itself is unit-tested in notify.test (injectable send); here we only guard that
  // the wiring in completeTask doesn't disturb the done path (epic lookup + notify
  // are best-effort, MAW_TEST_MODE suppresses the real spawn).
  test("completing an ask-subcard still closes cleanly + leaves the parent untouched", () => {
    const parent = addTask({ company: "pgw", title: "big work", by: "eq3", assignee: "patchwork", state: "in-progress" });
    const q = askTask("pgw", parent.id, "ship X or Y?", "tony", "patchwork")!;
    const done = completeTask("pgw", q.id, "tony");
    expect(done!.state).toBe("done");
    expect(readTask("pgw", parent.id)!.state).toBe("in-progress"); // notify only — parent state never flipped
  });
});

describe("approve state (kobo-189 — human gate between review and done)", () => {
  test("TASK_FLOW orders review → approve → done", () => {
    const i = (s: string) => TASK_FLOW.indexOf(s as never);
    expect(i("approve")).toBeGreaterThan(-1);
    expect(i("review")).toBeLessThan(i("approve"));
    expect(i("approve")).toBeLessThan(i("done"));
  });
  test("approve is a known state", () => {
    expect(TASK_STATES).toContain("approve");
  });
  test("a card can hold state=approve and round-trips through the store", () => {
    const t = addTask({ company: "pgw", title: "gate me", by: "eq3", assignee: "patchwork", state: "review" });
    const moved = moveTask("pgw", t.id, "approve", "tony");
    expect(moved!.state).toBe("approve");
    expect(readTask("pgw", t.id)!.state).toBe("approve"); // persisted
  });
  test("approve has a next-action hint (no dead-end)", () => {
    const t = addTask({ company: "pgw", title: "x", by: "eq3", assignee: "patchwork", state: "approve" });
    expect(taskNextAction(readTask("pgw", t.id)!)).toMatch(/approve/i);
  });
});
