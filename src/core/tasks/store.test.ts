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
  commentClarityError,
  pendingMentions,
  BLOCK_KINDS,
  blockNextAction,
  archiveTask,
  blockTask,
  checklistProgress,
  approvalTemplate,
  missingApprovalSections,
  claimTask,
  ReassignFrictionError,
  commentTask,
  migrateQuestionNotesToComments,
  reconcileTwoLaneCards,
  completeTask,
  completeOrParkMergedTask,
  isStaleDecisionCard,
  lastActivityByOracle,
  _resetActivityByOracleCache,
  STALE_DECISION_MS,
  createsEpicLoop,
  decomposeEpic,
  DEFAULT_ARCHIVE_DAYS,
  dependencyBlock,
  descendantCards,
  epicChildren,
  isTerminalState,
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
  needAnswerTask,
  moveTask,
  markDeployedTask,
  editTask,
  createsDepLoop,
  setTaskDep,
  setTaskEpic,
  setTaskPr,
  clearTaskPr,
  setTaskRepoIfMissing,
  startTask,
  taskFilePath,
  taskNextAction,
  tasksDir,
  tryCreateTaskRecord,
  unblockTask,
  requiredSignTiers,
  missingSignTiers,
  escalateCrewGate,
  reclassifyAndEscalate,
  type ParentState,
  type TaskRecord,
} from "./store";
import { openClaims, readWorklog, _resetWorklogCache } from "../worklog/store";

const dir = mkdtempSync(join(tmpdir(), "maw-tasks-"));
const prev = process.env.MAW_DATA_DIR;

beforeAll(() => { process.env.MAW_DATA_DIR = dir; });
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { rmSync(join(dir, "companies"), { recursive: true, force: true }); _resetWorklogCache(); });

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
    // kobo-219: displacing an existing owner is a reassign → needs force (correction)
    const assigned = assignTask("pgw", "pgw-1", "human", "patchwork", { force: true });
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
    assignTask("pgw", "pgw-1", "eq3", "eq3", { force: true }); // reassign to eq3 (correction)
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
    assignTask("pgw", "pgw-1", "eq3", "eq3", { force: true });
    expect(openClaims("pgw").filter((c) => (c.task ?? c.summary) === "pgw-1").length).toBe(0);
  });

  // kobo-219 — reassign is friction: displacing an existing owner without --force-reassign
  // is denied (Board Truth rule 9: assignee is the stable true doer, must not drift by accident).
  test("assignTask displacing an existing owner without force → throws ReassignFrictionError", () => {
    addTask({ company: "pgw", title: "t", by: "eq3" });
    claimTask("pgw", "pgw-1", "patchwork"); // owner = patchwork
    expect(() => assignTask("pgw", "pgw-1", "eq3", "eq3")).toThrow(ReassignFrictionError);
    expect(readTask("pgw", "pgw-1")?.assignee).toBe("patchwork"); // unchanged — not moved silently
  });

  test("assignTask friction error steers to correction + handoff=subtask", () => {
    addTask({ company: "pgw", title: "t", by: "eq3" });
    claimTask("pgw", "pgw-1", "patchwork");
    expect(() => assignTask("pgw", "pgw-1", "eq3", "eq3")).toThrow(/--force-reassign/);
    expect(() => assignTask("pgw", "pgw-1", "eq3", "eq3")).toThrow(/subtask/);
  });

  // Correction path: with force, reassign proceeds AND kobo-211 auto-release still fires.
  test("assignTask with force reassigns + releases the previous holder's claim (kobo-211 compat)", () => {
    addTask({ company: "pgw", title: "t", by: "eq3" });
    claimTask("pgw", "pgw-1", "patchwork"); // ⛏ patchwork
    const t = assignTask("pgw", "pgw-1", "eq3", "eq3", { force: true });
    expect(t?.assignee).toBe("eq3");
    const claims = openClaims("pgw").filter((c) => (c.task ?? c.summary) === "pgw-1");
    expect(claims.length).toBe(0); // old holder freed, new owner not fabricated
  });

  // First-assign (no existing owner) and idempotent (to === current) need no force —
  // nothing is displaced, so no friction.
  test("assignTask first-assign (unassigned → someone) needs no force", () => {
    addTask({ company: "pgw", title: "t", by: "eq3" }); // assignee = null
    const t = assignTask("pgw", "pgw-1", "eq3", "eq3");
    expect(t?.assignee).toBe("eq3");
  });

  test("assignTask idempotent (to === current owner) needs no force", () => {
    addTask({ company: "pgw", title: "t", by: "eq3" });
    claimTask("pgw", "pgw-1", "patchwork");
    const t = assignTask("pgw", "pgw-1", "patchwork", "patchwork");
    expect(t?.assignee).toBe("patchwork");
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

  // kobo-402: the worklog-derived map used to be re-parsed from scratch on every
  // call (median 50ms / max 297.8ms measured on a real 7.9MB/34,728-line worklog —
  // the single biggest contributor to /api/tasks blocking the event loop). Cached
  // by resolved path + byte size (append-only → unchanged size means unchanged
  // content). Pin: (1) a second call with no new writes returns the SAME object
  // reference (cache hit, not just equal values) (2) a write in between forces a
  // fresh read that reflects it (append-only growth invalidates correctly).
  test("lastActivityByOracle: caches by worklog size, invalidates on append (kobo-402)", () => {
    _resetActivityByOracleCache();
    addTask({ company: "cache1", title: "a", by: "eq3" });
    const first = lastActivityByOracle("cache1");
    const second = lastActivityByOracle("cache1");
    expect(second).toBe(first); // same reference — cache hit, no re-parse
    claimTask("cache1", "cache1-1", "patchwork"); // worklog grows (new append)
    const third = lastActivityByOracle("cache1");
    expect(third).not.toBe(first); // size changed → fresh parse, new object
    expect(third["patchwork"]).toBeGreaterThan(0); // and it actually sees the new entry
  });

  test("completeTask → done + emits task-done", () => {
    addTask({ company: "pgw", title: "t", by: "eq3" });
    const done = completeTask("pgw", "pgw-1", "tony");
    expect(done?.state).toBe("done");
    expect(readWorklog("pgw").some((e) => e.kind === "task-done" && e.task === "pgw-1")).toBe(true);
  });

  // kobo-275 — manual deploy-drain verb: wait-for-deploy → done, guarded to that lane.
  test("markDeployedTask: wait-for-deploy → done + emits task-done", () => {
    addTask({ company: "pgw", title: "ship", by: "eq3" });
    moveTask("pgw", "pgw-1", "wait-for-deploy", "eq3");
    const res = markDeployedTask("pgw", "pgw-1", "tony");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.task.state).toBe("done");
    expect(readTask("pgw", "pgw-1")?.state).toBe("done");
    expect(readWorklog("pgw").some((e) => e.kind === "task-done" && e.task === "pgw-1")).toBe(true);
  });

  test("markDeployedTask: card NOT in wait-for-deploy → not_waiting, NOT doned (guard)", () => {
    addTask({ company: "pgw", title: "still todo", by: "eq3" }); // pgw-1, state=todo
    const res = markDeployedTask("pgw", "pgw-1", "tony");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("not_waiting");
      if (res.reason === "not_waiting") expect(res.state).toBe("todo");
    }
    expect(readTask("pgw", "pgw-1")?.state).toBe("todo"); // untouched — never doned a non-waiting card
  });

  test("markDeployedTask: missing card → not_found", () => {
    const res = markDeployedTask("pgw", "pgw-999", "tony");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
  });

  // kobo-276 (epic-272 slice D) — env-change gate flow. An env-var change (e.g.
  // MAW_ROOM_COMPANY) is deploy-required by nature: it must not be marked done
  // before the value is applied + the server restarted. It rides the EXISTING
  // lanes — need-answer (value unclear) → approve (ask to apply) → wait-for-deploy
  // (kobo-273/274, awaiting restart) → done (kobo-275 deployed drain). No new lane,
  // no auto-detect: this locks that the full chain is traversable and that the
  // deploy park cannot be skipped.
  describe("env-change gate flow (kobo-276)", () => {
    test("traverses need-answer → approve → wait-for-deploy → done, each hop lands", () => {
      addTask({ company: "pgw", title: "set MAW_ROOM_COMPANY=kobo", by: "eq3" }); // pgw-1
      expect(moveTask("pgw", "pgw-1", "need-answer", "eq3")?.state).toBe("need-answer");
      expect(moveTask("pgw", "pgw-1", "approve", "eq3")?.state).toBe("approve");
      expect(moveTask("pgw", "pgw-1", "wait-for-deploy", "tony")?.state).toBe("wait-for-deploy");
      const res = markDeployedTask("pgw", "pgw-1", "tony"); // deploy applied + restarted
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.task.state).toBe("done");
      expect(readTask("pgw", "pgw-1")?.state).toBe("done");
    });

    test("cannot skip the deploy park — draining from approve is refused (guard)", () => {
      addTask({ company: "pgw", title: "set MAW_ROOM_COMPANY=kobo", by: "eq3" });
      moveTask("pgw", "pgw-1", "approve", "eq3");
      const res = markDeployedTask("pgw", "pgw-1", "tony"); // not parked yet
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("not_waiting");
      expect(readTask("pgw", "pgw-1")?.state).toBe("approve"); // stays put — no premature done
    });
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

  // kobo-555: the two kobo-229 CAPTURED-note tests that lived here were removed
  // along with the opts.captured mechanism itself (kobo-229's only producer,
  // hey auto-capture kobo-165, is gone) — see plugin-task-*/auto-create removal.

  test("noteTask still auto-advances a deliberate note (kobo-54, no regress after kobo-555's captured-opt removal)", () => {
    addTask({ company: "pgw", title: "t", by: "eq3", assignee: "patchwork" });
    const n = noteTask("pgw", "pgw-1", "patchwork", "diagnosing the repro");
    expect(n?.state).toBe("in-progress");
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
    for (const state of ["todo", "review"] as const) {
      const t = addTask({ company: "pgw", title: state, by: "eq3", assignee: "patchwork", state });
      expect(rejectTask("pgw", t.id, "tony", "no")?.state).toBe("rejected");
    }
    // a blocked card must carry a block {kind} (kobo-252 invariant) — reach it via blockTask,
    // not a bare state="blocked" (which the CLI never allows and the store now rejects).
    const b = addTask({ company: "pgw", title: "blocked", by: "eq3", assignee: "patchwork" });
    blockTask("pgw", b.id, "eq3", { kind: "needs_input", for: "tony" });
    expect(rejectTask("pgw", b.id, "tony", "no")?.state).toBe("rejected");
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

  // kobo-246 — the shared display gate: a terminal card's derived dep-block must not
  // re-surface it. dependencyBlock itself is unchanged; renders gate on this.
  test("isTerminalState: done/rejected/archived terminal; every active/off-flow state is not", () => {
    for (const s of ["done", "rejected", "archived"] as const) expect(isTerminalState(s)).toBe(true);
    for (const s of ["backlog", "todo", "ready", "in-progress", "review", "need-answer", "approve", "blocked"] as const) {
      expect(isTerminalState(s)).toBe(false); // an in-flow/off-flow card can still be dep-blocked
    }
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

describe("kobo-393 — wait-for-deploy counts as a satisfied parent state (kobo-377 root fix)", () => {
  const child = (parentIds: string[]): TaskRecord => ({
    id: "c", title: "t", company: "pgw", state: "todo", by: "x", assignee: null, ts: 1, parentIds,
  });

  test("dependencyBlock: wait-for-deploy parent satisfies (alongside done/archived)", () => {
    const states: Record<string, ParentState> = { p1: "wait-for-deploy", p2: "done", p3: "archived" };
    const resolve = (id: string) => states[id] ?? null;
    const r = dependencyBlock(child(["p1", "p2", "p3"]), resolve);
    expect(r.blockedBy).toEqual([]); // wait-for-deploy joins done/archived as satisfied
  });

  // kobo-395 follow-up (separate card): rejected is deliberately EXCLUDED from the
  // satisfied set — a rejected parent means the dep never happened, not "close enough".
  // Pinned here as a negative so 395 has a documented baseline to change on purpose.
  test("dependencyBlock: rejected parent does NOT satisfy — still blocks (kobo-395 baseline, not this card's scope)", () => {
    const resolve = (): ParentState => "rejected";
    expect(dependencyBlock(child(["p1"]), resolve).blockedBy).toEqual(["p1"]);
  });

  test("377 clobber repro: parent in wait-for-deploy → child's setTaskPr lands in review, NOT clobbered to blocked", () => {
    const parent = addTask({ company: "pgw", title: "parent", by: "x" });
    setTaskPr("pgw", parent.id, 200, "x"); // parent has a PR → deploy-required by default
    const child = addTask({ company: "pgw", title: "child", by: "x", assignee: "p", parentIds: [parent.id] });
    completeOrParkMergedTask("pgw", parent.id, "pr-watch"); // parent merges → parks in wait-for-deploy
    expect(readTask("pgw", parent.id)!.state).toBe("wait-for-deploy");
    const result = setTaskPr("pgw", child.id, 123, "x");
    expect(result!.state).toBe("review"); // NOT clobbered back to blocked (the 377 bug)
  });

  test("no-regression: parent still in-progress → setTaskPr on child DOES clobber to blocked (unchanged behavior)", () => {
    const parent = addTask({ company: "pgw", title: "parent", by: "x" });
    const child = addTask({ company: "pgw", title: "child", by: "x", assignee: "p", parentIds: [parent.id] });
    const result = setTaskPr("pgw", child.id, 124, "x");
    expect(result!.state).toBe("blocked"); // parent still pending → blocked wins, same as before this fix
    expect(result!.block?.kind).toBe("dependency");
  });

  // Design-blessed side-effect (eq3, kobo-393 note): promoteReadyChildren shares the
  // same dependencyBlock check, so a multi-parent child with one done + one merely
  // wait-for-deploy parent now ALSO promotes. Flagged, not silently absorbed — pinned
  // here so any future change to this behavior is a deliberate, visible diff.
  test("multi-parent side-effect: child with one done + one wait-for-deploy parent promotes todo→ready", () => {
    const doneParent = addTask({ company: "pgw", title: "done-parent", by: "x" });
    const wfdParent = addTask({ company: "pgw", title: "wfd-parent", by: "x" });
    setTaskPr("pgw", wfdParent.id, 201, "x"); // has a PR → deploy-required by default
    const child = addTask({ company: "pgw", title: "child", by: "x", parentIds: [doneParent.id, wfdParent.id] });
    expect(readTask("pgw", child.id)!.state).toBe("blocked"); // both parents pending → blocked at birth
    completeOrParkMergedTask("pgw", wfdParent.id, "pr-watch"); // → wait-for-deploy (not yet satisfied-triggering on its own)
    completeTask("pgw", doneParent.id, "x"); // → done, triggers promoteReadyChildren
    expect(readTask("pgw", child.id)!.state).toBe("ready"); // both parents now count satisfied
  });

  // Mixed case (kobo-394 coexistence guard): a wait-for-deploy parent must NOT hide
  // a genuinely still-pending parent — the card stays blocked, and the reason names
  // ONLY the real blocker. If the wfd parent leaked into the reason, that would be a
  // fresh 394-class board-lie (reason claiming something not actually blocking).
  test("mixed parents: wait-for-deploy parent satisfied + still-pending parent blocks — reason names ONLY the real blocker", () => {
    const wfdParent = addTask({ company: "pgw", title: "wfd-parent", by: "x" });
    setTaskPr("pgw", wfdParent.id, 300, "x");
    completeOrParkMergedTask("pgw", wfdParent.id, "pr-watch"); // → wait-for-deploy, satisfied
    const pendingParent = addTask({ company: "pgw", title: "pending-parent", by: "x" }); // stays todo, NOT satisfied
    const child = addTask({ company: "pgw", title: "child", by: "x", assignee: "p", parentIds: [wfdParent.id, pendingParent.id] });
    const result = setTaskPr("pgw", child.id, 301, "x");
    expect(result!.state).toBe("blocked"); // still blocked — pendingParent alone is enough
    expect(result!.block?.reason).toContain(pendingParent.id);
    expect(result!.block?.reason).not.toContain(wfdParent.id); // wfd parent correctly excluded — no coexistence lie with kobo-394's reason
  });
});

describe("ready state + auto-promote (kobo-133 — Hermes-style: state machine, not view)", () => {
  test("completeTask promotes a dependent todo card to ready + emits task-updated", () => {
    const parent = addTask({ company: "pgw", title: "parent", by: "x" });
    const child = addTask({ company: "pgw", title: "child", by: "x", assignee: "patchwork", parentIds: [parent.id] });
    // kobo-223: a dependency block is now a REAL state — a todo card born with a
    // pending parent opens blocked (kind=dependency), not a derived-todo overlay.
    expect(readTask("pgw", child.id)!.state).toBe("blocked");
    expect(readTask("pgw", child.id)!.block?.kind).toBe("dependency");
    completeTask("pgw", parent.id, "x");
    expect(readTask("pgw", child.id)!.state).toBe("ready"); // restored todo → ready (deps ครบ, kobo-133)
    const wl = readWorklog("pgw");
    expect(wl.some((e) => e.kind === "task-updated" && e.task === child.id && /ready/.test(e.summary))).toBe(true);
  });

  test("multi-parent: promotes only when the LAST pending parent closes", () => {
    const p1 = addTask({ company: "pgw", title: "p1", by: "x" });
    const p2 = addTask({ company: "pgw", title: "p2", by: "x" });
    const child = addTask({ company: "pgw", title: "child", by: "x", parentIds: [p1.id, p2.id] });
    completeTask("pgw", p1.id, "x");
    expect(readTask("pgw", child.id)!.state).toBe("blocked"); // kobo-223: p2 still pending → stays blocked
    completeTask("pgw", p2.id, "x");
    expect(readTask("pgw", child.id)!.state).toBe("ready"); // last parent closed → restored todo → ready
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
});

describe("dependency-block = real state + exact restore (kobo-223)", () => {
  test("2a round-trip: in-progress + new dep → blocked → parent done → in-progress (NOT ready)", () => {
    const parent = addTask({ company: "k223", title: "parent", by: "x" });
    const child = addTask({ company: "k223", title: "child", by: "x", assignee: "patchwork", state: "in-progress" });
    expect(readTask("k223", child.id)!.state).toBe("in-progress"); // working, no dep yet
    setTaskDep("k223", child.id, parent.id, "add", "x"); // gains a pending dep
    const blocked = readTask("k223", child.id)!;
    expect(blocked.state).toBe("blocked");
    expect(blocked.block?.kind).toBe("dependency");
    expect(blocked.prevState).toBe("in-progress"); // remembers where to return
    completeTask("k223", parent.id, "x"); // parent done → auto-unblock
    const back = readTask("k223", child.id)!;
    expect(back.state).toBe("in-progress"); // EXACT restore — NOT ready (2a: restoring the wrong state = board-lie)
    expect(back.block).toBeUndefined();
    expect(back.prevState).toBeUndefined();
  });

  test("2a round-trip: todo + dep → blocked → parent done → ready (deps ครบ, kobo-133 no-regress)", () => {
    const parent = addTask({ company: "k223b", title: "parent", by: "x" });
    const child = addTask({ company: "k223b", title: "child", by: "x", parentIds: [parent.id] });
    expect(readTask("k223b", child.id)!.state).toBe("blocked");
    completeTask("k223b", parent.id, "x");
    expect(readTask("k223b", child.id)!.state).toBe("ready");
  });

  test("dep rm restores the exact prior state (no auto-ready — that's the parent-DONE path)", () => {
    const parent = addTask({ company: "k223r", title: "parent", by: "x" });
    const child = addTask({ company: "k223r", title: "child", by: "x", assignee: "p", state: "in-progress", parentIds: [parent.id] });
    expect(readTask("k223r", child.id)!.state).toBe("blocked");
    setTaskDep("k223r", child.id, parent.id, "rm", "x"); // drop the only dep
    expect(readTask("k223r", child.id)!.state).toBe("in-progress"); // exact restore
  });

  test("3a multi-source: dep-blocked + explicit block → parent done keeps it blocked (explicit source remains)", () => {
    const parent = addTask({ company: "k223m", title: "parent", by: "x" });
    const child = addTask({ company: "k223m", title: "child", by: "x", assignee: "p", state: "in-progress", parentIds: [parent.id] });
    expect(readTask("k223m", child.id)!.state).toBe("blocked"); // dependency block
    blockTask("k223m", child.id, "eq3", { kind: "needs_input", for: "tony" }); // explicit block ON TOP
    expect(readTask("k223m", child.id)!.block?.kind).toBe("needs_input"); // explicit wins the kind
    completeTask("k223m", parent.id, "x"); // dep source clears...
    const still = readTask("k223m", child.id)!;
    expect(still.state).toBe("blocked"); // ...but explicit source remains → STAYS blocked (3a)
    expect(still.block?.kind).toBe("needs_input");
  });

  test("3a multi-source: manual unblock while dep still pending → re-blocks as dependency", () => {
    const parent = addTask({ company: "k223u", title: "parent", by: "x" });
    const child = addTask({ company: "k223u", title: "child", by: "x", assignee: "p", state: "in-progress", parentIds: [parent.id] });
    blockTask("k223u", child.id, "eq3", { kind: "needs_input", for: "tony" }); // now explicit-blocked, dep still pending
    unblockTask("k223u", child.id, "eq3"); // human clears the explicit source
    const t = readTask("k223u", child.id)!;
    expect(t.state).toBe("blocked"); // dep still pending → stays blocked
    expect(t.block?.kind).toBe("dependency"); // re-classified as the remaining source
    expect(t.prevState).toBe("in-progress"); // still remembers the flow lane
  });

  test("no-regress: explicit block on a DEP-LESS card round-trips untouched (todo→blocked→todo)", () => {
    const t = addTask({ company: "k223e", title: "solo", by: "x", assignee: "p" }); // todo, no deps
    blockTask("k223e", t.id, "eq3", { kind: "needs_input", for: "tony" });
    expect(readTask("k223e", t.id)!.state).toBe("blocked");
    unblockTask("k223e", t.id, "eq3");
    expect(readTask("k223e", t.id)!.state).toBe("todo"); // exact restore, no dependency re-block (no deps)
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

describe("block↔state mutual-exclusion invariant at the single write-path (kobo-252)", () => {
  test("point 1: a pending dep DRIVES state=blocked + kind=dependency + prevState (born blocked)", () => {
    const parent = addTask({ company: "k252a", title: "parent", by: "x" });
    const child = addTask({ company: "k252a", title: "child", by: "x", assignee: "p", state: "in-progress", parentIds: [parent.id] });
    const t = readTask("k252a", child.id)!;
    expect(t.state).toBe("blocked"); // real STATE, not a render overlay
    expect(t.block?.kind).toBe("dependency");
    expect(t.prevState).toBe("in-progress"); // remembers where to return (slice C restores it)
  });

  test("NORMALIZE: moving a blocked card to a flow lane strips the stale block (no blocked+other-lane lie)", () => {
    const t = addTask({ company: "k252b", title: "solo", by: "x", assignee: "p" });
    blockTask("k252b", t.id, "eq3", { kind: "needs_input", for: "tony" });
    const blocked = readTask("k252b", t.id)!;
    expect(blocked.state).toBe("blocked");
    expect(blocked.block?.kind).toBe("needs_input");
    expect(blocked.prevState).toBe("todo"); // remembered the flow lane
    // human moves it out of blocked → the write-path normalizes away the stale block context
    moveTask("k252b", t.id, "in-progress", "tony");
    const moved = readTask("k252b", t.id)!;
    expect(moved.state).toBe("in-progress");
    expect(moved.block).toBeUndefined(); // stale block gone — the record is ONE truth
    expect(moved.prevState).toBeUndefined(); // block context (return-lane) cleared too
  });

  test("REJECT: persisting state=blocked with no block {kind} is refused at the write-path", () => {
    const t = addTask({ company: "k252c", title: "solo", by: "x", assignee: "p" }); // todo, no block
    // a bare move into the blocked lane (no kind) — the CLI routes blocked via `block`,
    // so this kindless blocked write is a board-lie the store rejects.
    expect(() => moveTask("k252c", t.id, "blocked", "tony")).toThrow(/block \{kind\}/);
    expect(readTask("k252c", t.id)!.state).toBe("todo"); // untouched — the reject left the card as-is
  });

  test("a legitimately blocked card (block present) persists fine — the invariant only bites the lie", () => {
    const t = addTask({ company: "k252d", title: "solo", by: "x", assignee: "p" });
    expect(() => blockTask("k252d", t.id, "eq3", { kind: "transient", reason: "flaky CI" })).not.toThrow();
    expect(readTask("k252d", t.id)!.block?.kind).toBe("transient");
  });
});

describe("transition guards: every transition re-checks deps (kobo-253 slice B)", () => {
  // build a child that IS dep-blocked, then force a transition on it — it must snap back
  // to blocked instead of slipping into the actionable lane while the parent is pending.
  const depBlockedChild = (co: string, childState?: TaskState) => {
    const parent = addTask({ company: co, title: "parent", by: "x" });
    const child = addTask({ company: co, title: "child", by: "x", assignee: "p", state: childState ?? "todo", parentIds: [parent.id] });
    expect(readTask(co, child.id)!.state).toBe("blocked"); // born blocked (kobo-223)
    return { parent: parent.id, child: child.id };
  };

  test("start on a dep-pending card → snaps back to blocked (not in-progress)", () => {
    const { child } = depBlockedChild("k253a");
    startTask("k253a", child, "p");
    const t = readTask("k253a", child)!;
    expect(t.state).toBe("blocked"); // dep still pending → can't start
    expect(t.block?.kind).toBe("dependency");
    expect(t.prevState).toBe("in-progress"); // remembers the lane start aimed at
  });

  // kobo-394 — the block reconcile writes must carry a REASON naming the pending
  // parent + its state, so a verb's echo (or any consumer reading task.block) can
  // report the real "why", not a bare "blocked" with no explanation.
  test("dependency block carries a reason naming the still-pending parent + its state (kobo-394)", () => {
    const { parent, child } = depBlockedChild("k394reason");
    startTask("k394reason", child, "p");
    const t = readTask("k394reason", child)!;
    expect(t.state).toBe("blocked");
    expect(t.block?.reason).toContain(parent);
    expect(t.block?.reason).toContain("todo"); // the fresh parent's real state
  });

  test("claim on a dep-pending card → snaps back to blocked", () => {
    const { child } = depBlockedChild("k253b");
    claimTask("k253b", child, "someone");
    expect(readTask("k253b", child)!.state).toBe("blocked");
  });

  test("move-to-active (todo/in-progress/review) on a dep-pending card → lands blocked", () => {
    for (const target of ["todo", "in-progress", "review"] as const) {
      const { child } = depBlockedChild("k253m-" + target);
      moveTask("k253m-" + target, child, target, "tony");
      const t = readTask("k253m-" + target, child)!;
      expect(t.state).toBe("blocked"); // dep pending → target lane refused
      expect(t.prevState).toBe(target); // remembers where it was headed
    }
  });

  test("EDGE: PR opens (setTaskPr) while a dep is still pending → review→blocked (blocked wins)", () => {
    const { child } = depBlockedChild("k253pr");
    setTaskPr("k253pr", child, 999, "p", "owner/repo");
    const t = readTask("k253pr", child)!;
    expect(t.state).toBe("blocked"); // PR up but dep-waiting — blocked wins
    expect(t.prevState).toBe("review"); // restores to review when the dep clears (slice C)
    expect(t.pr).toBe(999); // the PR link is still recorded
  });

  test("EDGE: prOpenedReview (pr-watch) with a pending dep → blocked, not review", () => {
    const { child } = depBlockedChild("k253po");
    prOpenedReview("k253po", child, "author");
    expect(readTask("k253po", child)!.state).toBe("blocked");
  });

  // kobo-394 — the WORKLOG entry itself must not lie either: prOpenedReview/holdTask
  // used to always emit kind "task-review" with a "review"/"hold" message even when
  // the write got clobbered to blocked. Pin the emit kind flips too, not just state.
  test("kobo-394: prOpenedReview clobbered to blocked emits task-blocked, not task-review", () => {
    const { child } = depBlockedChild("k394pr-emit");
    prOpenedReview("k394pr-emit", child, "author");
    expect(readTask("k394pr-emit", child)!.state).toBe("blocked");
    const wl = readWorklog("k394pr-emit");
    expect(wl.some((e) => e.kind === "task-blocked" && e.task === child)).toBe(true);
    expect(wl.some((e) => e.kind === "task-review" && e.task === child)).toBe(false);
  });

  test("kobo-394: hold (non-gate) clobbered to blocked emits task-blocked, not task-review", () => {
    const { child } = depBlockedChild("k394hold-emit");
    holdTask("k394hold-emit", child, "eq3", "double-check");
    expect(readTask("k394hold-emit", child)!.state).toBe("blocked");
    const wl = readWorklog("k394hold-emit");
    expect(wl.some((e) => e.kind === "task-blocked" && e.task === child)).toBe(true);
    expect(wl.some((e) => e.kind === "task-review" && e.task === child)).toBe(false);
  });

  // kobo-394 round 2 — reviewer caught reviewTask + setTaskPr had the IDENTICAL
  // unconditional emit("task-review") the round-1 fix missed. Pin both, same shape.
  test("kobo-394 round 2: reviewTask clobbered to blocked emits task-blocked, not task-review", () => {
    const { child } = depBlockedChild("k394review-emit");
    reviewTask("k394review-emit", child, "eq3", {});
    expect(readTask("k394review-emit", child)!.state).toBe("blocked");
    const wl = readWorklog("k394review-emit");
    expect(wl.some((e) => e.kind === "task-blocked" && e.task === child)).toBe(true);
    expect(wl.some((e) => e.kind === "task-review" && e.task === child)).toBe(false);
  });

  test("kobo-394 round 2: setTaskPr clobbered to blocked emits task-blocked, not task-review", () => {
    const { child } = depBlockedChild("k394pr-set-emit");
    setTaskPr("k394pr-set-emit", child, 42, "eq3", "owner/repo");
    expect(readTask("k394pr-set-emit", child)!.state).toBe("blocked");
    const wl = readWorklog("k394pr-set-emit");
    expect(wl.some((e) => e.kind === "task-blocked" && e.task === child)).toBe(true);
    expect(wl.some((e) => e.kind === "task-review" && e.task === child)).toBe(false);
  });

  // negative — confirm the happy path (no pending dep) is UNCHANGED for both:
  // still emits task-review, no accidental task-blocked when nothing's actually blocked.
  test("kobo-394 round 2: reviewTask/setTaskPr on a dep-CLEAR card still emit task-review normally", () => {
    const parent = addTask({ company: "k394ok-emit", title: "parent", by: "x" });
    completeTask("k394ok-emit", parent.id, "x"); // deps clear
    const child = addTask({ company: "k394ok-emit", title: "child", by: "x", assignee: "p", parentIds: [parent.id] });
    reviewTask("k394ok-emit", child.id, "eq3", {});
    expect(readTask("k394ok-emit", child.id)!.state).toBe("review");
    setTaskPr("k394ok-emit", child.id, 7, "eq3", "o/r");
    const wl = readWorklog("k394ok-emit");
    expect(wl.filter((e) => e.kind === "task-review" && e.task === child.id).length).toBe(2);
    expect(wl.some((e) => e.kind === "task-blocked" && e.task === child.id)).toBe(false);
  });

  test("move-to-backlog is NOT force-blocked (parking lot is a valid park for a dep-pending card)", () => {
    const { child } = depBlockedChild("k253bl");
    moveTask("k253bl", child, "backlog", "tony");
    expect(readTask("k253bl", child)!.state).toBe("backlog"); // parked, not re-blocked
  });

  test("transitions on a dep-CLEAR card behave normally (guard only bites a pending dep)", () => {
    const parent = addTask({ company: "k253ok", title: "parent", by: "x" });
    const child = addTask({ company: "k253ok", title: "child", by: "x", assignee: "p", parentIds: [parent.id] });
    completeTask("k253ok", parent.id, "x"); // deps clear
    startTask("k253ok", child.id, "p");
    expect(readTask("k253ok", child.id)!.state).toBe("in-progress"); // no dep → normal transition
  });
});

// kobo-254 (slice C): auto-promote-back to prevState on dep-clear, GENERALIZED to every
// lane. The restore logic pre-exists (promoteReadyChildren exact-restore, kobo-223) — this
// suite LOCKS it across all lanes so a refactor can't regress it, with special focus on the
// review lane that slice B (kobo-253) newly made reachable as a prevState. Verified against
// alpha before writing (the mechanism is already correct); these are regression pins.
describe("auto-promote-back restores prevState on dep-clear — all lanes (kobo-254 slice C)", () => {
  // block a child from a specific lane (via a pending dep), returning ids + the parent to clear.
  const blockedFrom = (co: string, lane: "todo" | "in-progress" | "review") => {
    const parent = addTask({ company: co, title: "parent", by: "x" });
    const child = addTask({ company: co, title: "child", by: "x", assignee: "p", state: lane === "review" ? "in-progress" : lane, parentIds: [parent.id] });
    if (lane === "review") setTaskPr(co, child.id, 7, "p", "o/r"); // slice B: PR-open while dep pending → blocked, prevState=review
    const t = readTask(co, child.id)!;
    expect(t.state).toBe("blocked");
    expect(t.prevState).toBe(lane); // forced out of `lane`, remembered
    return { parent: parent.id, child: child.id };
  };

  test("prevState=review → parent done → auto-returns to REVIEW (the slice-B-enabled lane)", () => {
    const { parent, child } = blockedFrom("k254r", "review");
    completeTask("k254r", parent, "x");
    expect(readTask("k254r", child)!.state).toBe("review"); // restored to review, not todo/ready
    expect(readTask("k254r", child)!.block).toBeUndefined(); // block context cleared
    expect(readTask("k254r", child)!.prevState).toBeUndefined();
  });

  test("prevState=in-progress → parent done → auto-returns to IN-PROGRESS (not ready)", () => {
    const { parent, child } = blockedFrom("k254i", "in-progress");
    completeTask("k254i", parent, "x");
    expect(readTask("k254i", child)!.state).toBe("in-progress");
  });

  test("prevState=todo → parent done → TODO promotes to READY (kobo-133 no-regress)", () => {
    const { parent, child } = blockedFrom("k254t", "todo");
    completeTask("k254t", parent, "x");
    expect(readTask("k254t", child)!.state).toBe("ready");
  });

  test("multi-dep: restore fires only when the LAST dep clears (not on the first)", () => {
    const p1 = addTask({ company: "k254m", title: "p1", by: "x" });
    const p2 = addTask({ company: "k254m", title: "p2", by: "x" });
    const child = addTask({ company: "k254m", title: "child", by: "x", assignee: "p", state: "in-progress", parentIds: [p1.id, p2.id] });
    expect(readTask("k254m", child.id)!.state).toBe("blocked");
    completeTask("k254m", p1.id, "x");
    expect(readTask("k254m", child.id)!.state).toBe("blocked"); // p2 still pending → stays blocked
    completeTask("k254m", p2.id, "x");
    expect(readTask("k254m", child.id)!.state).toBe("in-progress"); // ALL clear → restore
  });

  test("archive satisfies a dep too — an archived parent promotes the child back", () => {
    const { parent, child } = blockedFrom("k254a", "review");
    archiveTask("k254a", parent, "x", { force: true });
    expect(readTask("k254a", child)!.state).toBe("review"); // archived parent = satisfied dep
  });

  test("removing the last dep (setTaskDep rm) also restores the exact prevState", () => {
    const { parent, child } = blockedFrom("k254d", "in-progress");
    setTaskDep("k254d", child, parent, "rm", "x"); // drop the dep instead of completing it
    expect(readTask("k254d", child)!.state).toBe("in-progress"); // exact restore via reconcile EXIT
  });

  test("an EXPLICIT block (kind≠dependency) is NOT auto-promoted when the dep clears (3a)", () => {
    const parent = addTask({ company: "k254x", title: "parent", by: "x" });
    const child = addTask({ company: "k254x", title: "child", by: "x", assignee: "p", state: "in-progress", parentIds: [parent.id] });
    blockTask("k254x", child.id, "eq3", { kind: "needs_input", for: "tony" }); // explicit block on top
    completeTask("k254x", parent.id, "x"); // dep source clears...
    expect(readTask("k254x", child.id)!.state).toBe("blocked"); // ...explicit source remains → stays blocked
    expect(readTask("k254x", child.id)!.block?.kind).toBe("needs_input");
  });
});

// kobo-256 (slice E): explicit block (maw task block) and dep-block resolve to ONE
// exclusive blocked lane — the same {state:"blocked", block:{kind}, prevState} shape,
// through the same write-path + invariant (slice A). Both surfaces (CLI/MCP) drive the
// same store verbs, so the lane is identical no matter how a card got blocked. The logic
// pre-exists (A's enforceBlockInvariant made "blocked ⟺ block" true for BOTH paths); this
// suite LOCKS the unification so a refactor can't split them back into two representations.
describe("explicit-block + dep-block unify to one exclusive lane (kobo-256 slice E)", () => {
  test("explicit block on an in-progress card → EXCLUSIVE blocked (state=blocked, prevState, block) — not in-progress+field", () => {
    const t = addTask({ company: "k256x", title: "t", by: "x", assignee: "p", state: "in-progress" });
    blockTask("k256x", t.id, "eq3", { kind: "needs_input", reason: "waiting on Tony", for: "tony" });
    const b = readTask("k256x", t.id)!;
    expect(b.state).toBe("blocked"); // the card LEFT in-progress — exclusive, not layered
    expect(b.prevState).toBe("in-progress"); // remembers the lane it was pulled from
    expect(b.block).toMatchObject({ kind: "needs_input", reason: "waiting on Tony", for: "tony" });
  });

  test("explicit-block and dep-block produce the SAME exclusive shape (one lane, two sources)", () => {
    // explicit
    const e = addTask({ company: "k256s", title: "e", by: "x", assignee: "p", state: "in-progress" });
    blockTask("k256s", e.id, "eq3", { kind: "capability" });
    const eb = readTask("k256s", e.id)!;
    // dep
    const parent = addTask({ company: "k256s", title: "parent", by: "x" });
    const d = addTask({ company: "k256s", title: "d", by: "x", assignee: "p", state: "in-progress", parentIds: [parent.id] });
    const db = readTask("k256s", d.id)!;
    // same lane, same structural shape — only the kind differs (the source)
    expect(eb.state).toBe("blocked");
    expect(db.state).toBe("blocked");
    expect(Object.keys(eb).filter((k) => k === "state" || k === "block" || k === "prevState").sort())
      .toEqual(Object.keys(db).filter((k) => k === "state" || k === "block" || k === "prevState").sort());
    expect(eb.block!.kind).toBe("capability"); // explicit source
    expect(db.block!.kind).toBe("dependency"); // dep source
    expect(eb.prevState).toBe("in-progress");
    expect(db.prevState).toBe("in-progress");
  });

  test("unblock an explicitly-blocked card → restores the exact prevState (one lane out, same as dep-clear)", () => {
    const t = addTask({ company: "k256u", title: "t", by: "x", assignee: "p", state: "review" });
    blockTask("k256u", t.id, "eq3", { kind: "transient", reason: "flaky infra" });
    expect(readTask("k256u", t.id)!.state).toBe("blocked");
    unblockTask("k256u", t.id, "eq3");
    const u = readTask("k256u", t.id)!;
    expect(u.state).toBe("review"); // exact restore
    expect(u.block).toBeUndefined();
    expect(u.prevState).toBeUndefined();
  });

  test("a card blocked by BOTH sources: unblock clears the explicit one but a pending dep keeps it blocked (3a — still one lane)", () => {
    const parent = addTask({ company: "k256b", title: "parent", by: "x" });
    const child = addTask({ company: "k256b", title: "child", by: "x", assignee: "p", state: "in-progress", parentIds: [parent.id] });
    blockTask("k256b", child.id, "eq3", { kind: "needs_input", for: "tony" }); // explicit ON TOP of the dep block
    expect(readTask("k256b", child.id)!.block?.kind).toBe("needs_input"); // explicit wins the kind
    unblockTask("k256b", child.id, "eq3"); // human clears the explicit source
    const t = readTask("k256b", child.id)!;
    expect(t.state).toBe("blocked"); // dep still pending → STAYS on the one blocked lane
    expect(t.block?.kind).toBe("dependency"); // re-resolves to the remaining source
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

describe("editTask (kobo-213 — non-destructive title/body reword, same id)", () => {
  test("edits title + body in place; id + deps + thread + PR intact; old wording preserved in an audit note", () => {
    const p = addTask({ company: "pgw", title: "parent", by: "x" });
    const t = addTask({ company: "pgw", title: "old title", by: "eq3", assignee: "patchwork", body: "old body", parentIds: [p.id] });
    commentTask("pgw", t.id, "eq3", "a question");
    setTaskPr("pgw", t.id, 77, "patchwork"); // PR link + review flip
    const before = readTask("pgw", t.id)!;

    const edited = editTask("pgw", t.id, "tony", { title: "new title", body: "new body" })!;
    expect(edited.id).toBe(t.id); // same id
    expect(edited.title).toBe("new title");
    expect(edited.body).toBe("new body");
    // lineage untouched
    expect(edited.parentIds).toEqual([p.id]);
    expect(edited.comments).toHaveLength(1);
    expect(edited.pr).toBe(77);
    expect(edited.state).toBe(before.state); // review — not changed
    expect(edited.assignee).toBe(before.assignee); // patchwork — not changed
    // audit: old values preserved in an append-only note (Nothing is Deleted)
    const audit = edited.notes!.at(-1)!;
    expect(audit.by).toBe("tony");
    expect(audit.text).toContain("old title");
    expect(audit.text).toContain("old body");
    // and a worklog event
    expect(readWorklog("pgw").some((e) => e.kind === "task-updated" && e.task === t.id && /edited/.test(e.summary))).toBe(true);
  });

  test("title-only edit leaves body untouched; body-only leaves title untouched", () => {
    addTask({ company: "pgw", title: "T", by: "x", body: "B" });
    const a = editTask("pgw", "pgw-1", "x", { title: "T2" })!;
    expect(a.title).toBe("T2");
    expect(a.body).toBe("B");
    const b = editTask("pgw", "pgw-1", "x", { body: "B2" })!;
    expect(b.title).toBe("T2");
    expect(b.body).toBe("B2");
  });

  test("no-op when nothing changes (same values) → no audit note added", () => {
    addTask({ company: "pgw", title: "same", by: "x", body: "body" });
    const before = readTask("pgw", "pgw-1")!;
    const n0 = before.notes?.length ?? 0;
    const r = editTask("pgw", "pgw-1", "x", { title: "same", body: "body" })!;
    expect(r.notes?.length ?? 0).toBe(n0); // no audit noise
  });

  test("edit does NOT auto-advance a todo card (an edit is not 'working it')", () => {
    addTask({ company: "pgw", title: "t", by: "eq3", assignee: "patchwork" }); // todo
    const r = editTask("pgw", "pgw-1", "patchwork", { title: "reworded" })!;
    expect(r.state).toBe("todo"); // unlike noteTask, no todo→in-progress flip
  });

  test("missing card → null (no throw)", () => {
    expect(editTask("pgw", "pgw-999", "x", { title: "x" })).toBeNull();
  });

  test("edits reviewer in place; combinable with title; old reviewer preserved in audit; lineage intact (kobo-214)", () => {
    const p = addTask({ company: "pgw", title: "parent", by: "x" });
    const t = addTask({ company: "pgw", title: "card", by: "eq3", assignee: "patchwork", reviewer: "eq3", parentIds: [p.id] });
    setTaskPr("pgw", t.id, 88, "patchwork"); // PR link — lineage to check

    const edited = editTask("pgw", t.id, "tony", { reviewer: "worker", title: "card v2" })!;
    expect(edited.id).toBe(t.id); // same id
    expect(edited.reviewer).toBe("worker"); // reviewer updated
    expect(edited.title).toBe("card v2"); // combinable with --title in one edit
    // lineage untouched
    expect(edited.parentIds).toEqual([p.id]);
    expect(edited.pr).toBe(88);
    expect(edited.assignee).toBe("patchwork"); // assignee not touched (OUT of scope)
    // audit: old reviewer preserved in an append-only note (Nothing is Deleted)
    const audit = edited.notes!.at(-1)!;
    expect(audit.by).toBe("tony");
    expect(audit.text).toContain("reviewer was: eq3");
  });

  test("reviewer-only edit leaves title/body untouched; no-op when reviewer unchanged (kobo-214)", () => {
    addTask({ company: "pgw", title: "T", by: "x", body: "B", reviewer: "eq3" });
    const a = editTask("pgw", "pgw-1", "x", { reviewer: "human" })!;
    expect(a.reviewer).toBe("human");
    expect(a.title).toBe("T");
    expect(a.body).toBe("B");
    const n = readTask("pgw", "pgw-1")!.notes?.length ?? 0;
    const b = editTask("pgw", "pgw-1", "x", { reviewer: "human" })!; // same value → no-op
    expect(b.notes?.length ?? 0).toBe(n); // no audit noise
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
  test("linked card → review; the doer (assignee) is KEPT, NOT overwritten by the PR author (kobo-217); reviewer=creator + emits task-review", () => {
    const t = addTask({ company: "pgw", title: "ship it", by: "eq3", assignee: "patchwork" }); // doer = patchwork
    setTaskPr("pgw", t.id, 77, "patchwork"); // worker attaches PR at open (the card.pr link)
    const r = prOpenedReview("pgw", t.id, "meganechan")!; // PR author = the shared github account
    expect(r.state).toBe("review");
    expect(r.assignee).toBe("patchwork"); // kobo-217: doer kept — NOT reassigned to the PR author (Board Truth rule 9)
    expect(r.reviewer).toBe("eq3"); // kobo-144: creator (who wrote the AC) reviews, not hardcoded human
    expect(readWorklog("pgw").some((e) => e.kind === "task-review" && e.task === t.id)).toBe(true);
  });

  test("unassigned card + PR open → still no assignee (the meaningless PR author is never stamped as owner) (kobo-217)", () => {
    const t = addTask({ company: "pgw", title: "no doer yet", by: "eq3" }); // unassigned
    const r = prOpenedReview("pgw", t.id, "meganechan")!;
    expect(r.state).toBe("review");
    expect(r.assignee).toBeFalsy(); // no false owner — never "meganechan"; the derived needsOwner surfaces it
    expect(r.assignee).not.toBe("meganechan");
    expect(r.reviewer).toBe("eq3"); // creator reviews
  });

  test("creator IS the PR author → self-review banned → reviewer=human (kobo-144 addendum)", () => {
    const t = addTask({ company: "pgw", title: "solo card", by: "patchwork" }); // creator = the doer
    const r = prOpenedReview("pgw", t.id, "patchwork")!; // same person opens the PR
    expect(r.reviewer).toBe("human"); // can't review own work → falls through to the human
  });

  test("self-review guard keys off the real doer (assignee), not the shared-github PR author (kobo-217)", () => {
    // creator == doer (patchwork), but the PR is opened from the shared account.
    const t = addTask({ company: "pgw", title: "solo, shared account", by: "patchwork", assignee: "patchwork" });
    const r = prOpenedReview("pgw", t.id, "meganechan")!; // author ≠ doer, but doer still can't review own work
    expect(r.assignee).toBe("patchwork"); // doer kept
    expect(r.reviewer).toBe("human"); // guard uses assignee → self-review still banned → human
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

  // kobo-224 — a GATED brake = reviewer judged it a Tony-gate (big) card → route to
  // the approve lane (Tony's queue) instead of review, replacing hold+@tony.
  test("gate:true routes the brake to the APPROVE lane, not review (kobo-224)", () => {
    const t = addTask({ company: "hold", title: "deploy migration", by: "eq3", assignee: "patchwork", state: "todo" });
    startTask("hold", t.id, "patchwork"); // in-progress
    const gated = holdTask("hold", t.id, "eq3", "live deploy — Tony must bless", { gate: true })!;
    expect(gated.state).toBe("approve"); // Tony's queue, NOT review
    expect(gated.reviewReason).toBe("live deploy — Tony must bless");
    expect(readTask("hold", t.id)!.state).toBe("approve");
  });

  test("gate:true with an empty reason → null (approve-lane invariant: no reason-less park)", () => {
    const t = addTask({ company: "hold", title: "x", by: "eq3", assignee: "patchwork" });
    expect(holdTask("hold", t.id, "eq3", "", { gate: true })).toBeNull();
    expect(holdTask("hold", t.id, "eq3", "   ", { gate: true })).toBeNull();
    expect(readTask("hold", t.id)!.state).not.toBe("approve"); // never parked without a reason
    expect(holdTask("hold", t.id, "eq3", undefined, { gate: true })).toBeNull();
  });

  // 🔒🔒 CRITICAL (Tony): approve = queue-for-bless ONLY. Tony bless ≠ auto-deploy.
  // A gated brake is a PURE lane move — it emits only a review event and triggers no
  // deploy/exec/action of any kind (there must be NO approve→deploy wire).
  test("gate:true is a pure lane move — emits only task-review, ZERO deploy/exec side-effect (kobo-224)", () => {
    const t = addTask({ company: "gatewire", title: "prod deploy card", by: "eq3", assignee: "patchwork" });
    reviewTask("gatewire", t.id, "patchwork");
    const before = readWorklog("gatewire").length;
    holdTask("gatewire", t.id, "eq3", "deploy needs Tony", { gate: true });
    const added = readWorklog("gatewire").slice(before);
    // the ONLY event is the review/lane move — no deploy/run/exec/action kind exists
    expect(added.every((e) => e.kind === "task-review")).toBe(true);
    expect(added.some((e) => /deploy|exec|run|action|trigger/i.test(e.kind))).toBe(false);
    // card carries no deploy trigger — it just sits in the approve lane awaiting a human
    expect(readTask("gatewire", t.id)!.state).toBe("approve");
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

describe("needAnswerTask (kobo-218 — Tony's decision queue, off-flow, question mandatory)", () => {
  test("parks a card in need-answer with the mandatory question; assignee (owner) untouched", () => {
    const t = addTask({ company: "app", title: "which schema?", by: "eq3", assignee: "patchwork" });
    startTask("app", t.id, "patchwork"); // in-progress
    const n = needAnswerTask("app", t.id, "patchwork", "  A or B for the store shape?  ")!;
    expect(n.state).toBe("need-answer");
    expect(n.reviewReason).toBe("A or B for the store shape?"); // trimmed question, persisted
    expect(n.assignee).toBe("patchwork"); // Board Truth rule 9 — doer stays the owner
    expect(readWorklog("app").some((e) => e.kind === "task-review" && e.task === t.id)).toBe(true);
  });
  test("empty/whitespace question → null (no reason-less park); missing card → null", () => {
    const t = addTask({ company: "app", title: "x", by: "eq3", assignee: "patchwork" });
    expect(needAnswerTask("app", t.id, "patchwork", "")).toBeNull();
    expect(needAnswerTask("app", t.id, "patchwork", "   ")).toBeNull();
    expect(readTask("app", t.id)!.state).not.toBe("need-answer");
    expect(needAnswerTask("app", "app-999", "patchwork", "why")).toBeNull();
  });
  test("owner moves the card back to its next step via an existing verb (no auto-transition)", () => {
    const t = addTask({ company: "app", title: "decide", by: "eq3", assignee: "patchwork" });
    needAnswerTask("app", t.id, "patchwork", "go or no-go?");
    const back = startTask("app", t.id, "patchwork")!; // Tony answered → owner resumes work
    expect(back.state).toBe("in-progress");
  });
});

describe("addTask born-in-approve (kobo-218 — CREATE a deploy-approval card into the Approve lane)", () => {
  test("state=approve + reviewReason → card opens in approve carrying the WHY", () => {
    const t = addTask({ company: "app", title: "deploy m5", by: "eq3", assignee: "patchwork", state: "approve", reviewReason: "restart maw-server on m5" });
    expect(t.state).toBe("approve");
    expect(t.reviewReason).toBe("restart maw-server on m5"); // Approve lane invariant — every card says why
  });
});

describe("approval-card 9-section template (kobo-222)", () => {
  test("approvalTemplate has all 9 numbered headings + hint comments", () => {
    const tpl = approvalTemplate();
    for (let n = 1; n <= 9; n++) expect(tpl).toContain(`## ${n}.`);
    expect(tpl).toContain("## 4. เงิน");
    expect(tpl).toContain("<!-- ทิศทาง in/out · money-out=0? -->");
    expect(missingApprovalSections(tpl)).toEqual([]); // the template itself is complete
  });
  test("missingApprovalSections: empty/absent body → all 9 missing", () => {
    expect(missingApprovalSections("").map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(missingApprovalSections(undefined).map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
  test("missingApprovalSections: matches numbered headings, reports only the gaps in order", () => {
    const partial = "## 1. Deploy\ntext\n2. change\n### 9. honest";
    expect(missingApprovalSections(partial).map((s) => s.n)).toEqual([3, 4, 5, 6, 7, 8]);
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

  test("commentClarityError (kobo-265): only ASK is gated (@tony-only); tldr is auto-derived, agent↔agent free", () => {
    // @tony without ask → error (tldr auto-derived from text, so it's NOT the tldr that's missing)
    expect(commentClarityError("@tony approve the deploy?", undefined, undefined)).toContain("--ask");
    expect(commentClarityError("@human decide", "x", "  ")).toContain("--ask"); // blank ask → still error
    // mention in any field still triggers the ask requirement
    expect(commentClarityError("see below", undefined, undefined, "@tony approve X?")).toContain("--ask");
    // @tony WITH ask → ok, even without an explicit tldr (fallback fills it)
    expect(commentClarityError("@tony approve prod?", undefined, "approve prod?")).toBeNull();
    // agent↔agent → free: no ask needed, tldr auto-filled downstream
    expect(commentClarityError("fix done", undefined, undefined)).toBeNull();
    expect(commentClarityError("@eq3 lgtm merging", undefined, undefined)).toBeNull();
  });

  test("commentTask auto-derives tldr from text; multiline routes remainder → detail (kobo-265)", () => {
    const t = addTask({ company: "pgw", title: "c", by: "eq3" });
    // single line, no --tldr → tldr = the line, no detail
    commentTask("pgw", t.id, "eq3", "fix done", undefined, {});
    const a = readTask("pgw", t.id)!.comments!.at(-1)!;
    expect(a.tldr).toBe("fix done"); expect(a.detail).toBeUndefined();
    // multiline, no --tldr → tldr = first line, detail = the rest (nothing lost)
    commentTask("pgw", t.id, "eq3", "line1\nline2\nline3", undefined, {});
    const b = readTask("pgw", t.id)!.comments!.at(-1)!;
    expect(b.tldr).toBe("line1"); expect(b.detail).toBe("line2\nline3");
    // explicit --tldr / --detail win — fallback never clobbers them
    commentTask("pgw", t.id, "eq3", "raw body\nmore", undefined, { tldr: "explicit", detail: "explicit detail" });
    const c = readTask("pgw", t.id)!.comments!.at(-1)!;
    expect(c.tldr).toBe("explicit"); expect(c.detail).toBe("explicit detail");
    // explicit --tldr only (no --detail) → fallback does NOT inject the body as detail
    commentTask("pgw", t.id, "eq3", "b1\nb2", undefined, { tldr: "explicit2" });
    const d = readTask("pgw", t.id)!.comments!.at(-1)!;
    expect(d.tldr).toBe("explicit2"); expect(d.detail).toBeUndefined();
    // @tony structured still stores ask
    commentTask("pgw", t.id, "eq3", "@tony", undefined, { tldr: "deploy green", ask: "approve prod?", detail: "logs ok" });
    expect(readTask("pgw", t.id)!.comments!.at(-1)).toMatchObject({ tldr: "deploy green", ask: "approve prod?", detail: "logs ok" });
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

  test("pendingMentions reads every COMMENT with an @mention (kobo-237: no resolve drop)", () => {
    const a = addTask({ company: "pgw", title: "card A", by: "eq3" });
    commentTask("pgw", a.id, "eq3", "@tony rename to Foo?");
    const b = addTask({ company: "pgw", title: "card B", by: "eq3" });
    commentTask("pgw", b.id, "eq3", "@patchwork bump dep");

    const all = pendingMentions("pgw");
    expect(all.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    expect(all.every((m) => m.commentId === "c1")).toBe(true); // carries the comment id
    // --for filters (and @human aliases to tony)
    expect(pendingMentions("pgw", "human").map((m) => m.id)).toEqual([a.id]);
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

  // kobo-237: resolveComment removed — the resolve concept is gone. The comment/reply
  // thread (above) still works; a comment is never resolved/closed.

  // kobo-142 (C3): migrate question-notes (notes with @mentions — the old ask
  // channel) into comments[] on ACTIVE cards. COPY (note kept), idempotent.
  // kobo-237: NO resolve stamping — migrated comments are plain comments.
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

  test("migrateQuestionNotesToComments does NOT resolve an answered note (kobo-237: resolve gone)", () => {
    const b = addTask({ company: "pgw", title: "card B", by: "eq3" });
    noteTask("pgw", b.id, "eq3", "@tony ship X or Y?");
    noteTask("pgw", b.id, "tony", "Y please"); // tony replied later — no longer special

    migrateQuestionNotesToComments("pgw");
    const cb = readTask("pgw", b.id)!;
    expect(cb.comments![0].resolved).toBeUndefined(); // no resolve stamping anymore
    expect(pendingMentions("pgw", "tony").map((m) => m.id)).toEqual([b.id]); // stays in the queue
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

describe("reconcileTwoLaneCards — one-shot 2-lane migration (kobo-257, epic 251 slice F)", () => {
  // Fabricate a PRE-FIX 2-lane lie: a card persisted in a FLOW lane with a still-pending
  // dep and NO block — the shape the write-path now prevents but old records still hold.
  const fabricate2Lane = (co: string, flowState: "review" | "in-progress") => {
    const parent = addTask({ company: co, title: "parent", by: "x" }); // stays todo → pending
    const child = addTask({ company: co, title: "child", by: "x", assignee: "p" });
    const rec = readTask(co, child.id)!;
    rec.state = flowState; rec.parentIds = [parent.id]; delete rec.block; delete rec.prevState;
    require("fs").writeFileSync(taskFilePath(co, child.id), JSON.stringify(rec));
    return { parent: parent.id, child: child.id };
  };

  test("forces a review/in-progress card with a pending dep → blocked + prevState (restorable)", () => {
    for (const lane of ["review", "in-progress"] as const) {
      const co = "k257f-" + lane;
      const { child } = fabricate2Lane(co, lane);
      const res = reconcileTwoLaneCards({ company: co });
      expect(res.changed).toBe(1);
      const t = readTask(co, child)!;
      expect(t.state).toBe("blocked");
      expect(t.block?.kind).toBe("dependency");
      expect(t.prevState).toBe(lane); // remembers the flow lane — Nothing Deleted
    }
  });

  test("restores a dep-blocked card whose dep already cleared → prevState (pre-fix backlog)", () => {
    const co = "k257r";
    const parent = addTask({ company: co, title: "parent", by: "x" });
    const child = addTask({ company: co, title: "child", by: "x", assignee: "p" });
    completeTask(co, parent.id, "x"); // parent done BEFORE child got the dep — live promote never fired
    const rec = readTask(co, child.id)!;
    rec.state = "blocked"; rec.block = { kind: "dependency" }; rec.prevState = "review"; rec.parentIds = [parent.id];
    require("fs").writeFileSync(taskFilePath(co, child.id), JSON.stringify(rec));
    const res = reconcileTwoLaneCards({ company: co });
    expect(res.changed).toBe(1);
    const t = readTask(co, child.id)!;
    expect(t.state).toBe("review"); // restored to exact prevState
    expect(t.block).toBeUndefined();
    expect(t.prevState).toBeUndefined();
  });

  test("idempotent + non-destructive + dry-run writes nothing", () => {
    const co = "k257i";
    const { child } = fabricate2Lane(co, "review");
    const dry = reconcileTwoLaneCards({ company: co, dryRun: true });
    expect(dry.changed).toBe(1); // reports what WOULD change
    expect(readTask(co, child)!.state).toBe("review"); // but writes nothing
    expect(reconcileTwoLaneCards({ company: co }).changed).toBe(1); // real run corrects it
    const t = readTask(co, child)!;
    expect(t.title).toBe("child"); expect(t.assignee).toBe("p"); // identity intact — non-destructive
    expect(reconcileTwoLaneCards({ company: co }).changed).toBe(0); // rerun → no-op (one truth)
  });

  test("scans ALL companies by default", () => {
    fabricate2Lane("k257all-a", "review");
    fabricate2Lane("k257all-b", "in-progress");
    const res = reconcileTwoLaneCards();
    expect(res.outcomes.some((o) => o.company === "k257all-a")).toBe(true);
    expect(res.outcomes.some((o) => o.company === "k257all-b")).toBe(true);
    expect(res.changed).toBeGreaterThanOrEqual(2);
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

describe("completeOrParkMergedTask — merge flip routes deploy-required → wait-for-deploy (kobo-274)", () => {
  test("has-PR card (no explicit field) parks in wait-for-deploy — the has-PR default", () => {
    const t = addTask({ company: "pgw", title: "ships code", by: "eq3", assignee: "patchwork" });
    setTaskPr("pgw", t.id, 500, "patchwork"); // linked PR → deploy-required by default
    const r = completeOrParkMergedTask("pgw", t.id, "pr-watch")!;
    expect(r.state).toBe("wait-for-deploy");
  });

  test("no-PR card goes straight to done — nothing to deploy", () => {
    const t = addTask({ company: "pgw", title: "board-op", by: "eq3", assignee: "patchwork" });
    const r = completeOrParkMergedTask("pgw", t.id, "pr-watch")!;
    expect(r.state).toBe("done");
  });

  test("override: deployRequired=false on a has-PR card → done (docs/test PR)", () => {
    const t = addTask({ company: "pgw", title: "docs only", by: "eq3", assignee: "patchwork", deployRequired: false });
    setTaskPr("pgw", t.id, 501, "patchwork");
    expect(completeOrParkMergedTask("pgw", t.id, "pr-watch")!.state).toBe("done");
  });

  test("override: deployRequired=true on a no-PR card → wait-for-deploy", () => {
    const t = addTask({ company: "pgw", title: "no pr but deploys", by: "eq3", assignee: "patchwork", deployRequired: true });
    expect(completeOrParkMergedTask("pgw", t.id, "pr-watch")!.state).toBe("wait-for-deploy");
  });

  test("parking is NON-terminal — a dependent child is NOT promoted (unlike done)", () => {
    const parent = addTask({ company: "pgw", title: "parent ships", by: "eq3", assignee: "patchwork" });
    setTaskPr("pgw", parent.id, 502, "patchwork");
    const child = addTask({ company: "pgw", title: "child", by: "eq3", assignee: "patchwork", parentIds: [parent.id] });
    expect(readTask("pgw", child.id)!.state).toBe("blocked"); // dep-blocked on the parent
    completeOrParkMergedTask("pgw", parent.id, "pr-watch"); // parent parks, not done
    expect(readTask("pgw", child.id)!.state).toBe("blocked"); // still blocked — parent isn't done yet
  });

  test("editTask flips deployRequired in place (override after the fact)", () => {
    const t = addTask({ company: "pgw", title: "reclassify", by: "eq3", assignee: "patchwork" });
    setTaskPr("pgw", t.id, 503, "patchwork");
    editTask("pgw", t.id, "eq3", { deployRequired: false }); // reviewer marks it non-deploy
    expect(completeOrParkMergedTask("pgw", t.id, "pr-watch")!.state).toBe("done");
  });

  test("already-parked card → idempotent no-op (no updatedTs bump, no re-emit)", () => {
    const t = addTask({ company: "pgw", title: "ships", by: "eq3", assignee: "patchwork" });
    setTaskPr("pgw", t.id, 504, "patchwork");
    const parked = completeOrParkMergedTask("pgw", t.id, "pr-watch")!;
    expect(parked.state).toBe("wait-for-deploy");
    const stamp = readTask("pgw", t.id)!.updatedTs;
    const again = completeOrParkMergedTask("pgw", t.id, "pr-watch")!; // second call — guard hits
    expect(again.state).toBe("wait-for-deploy");
    expect(readTask("pgw", t.id)!.updatedTs).toBe(stamp); // no bump → no churn
  });

  test("missing card → null (no throw)", () => {
    expect(completeOrParkMergedTask("pgw", "pgw-999", "x")).toBeNull();
  });
});

// kobo-507 — the real kobo-495 shape: a card's linked PR closes without merging
// (superseded by a different PR/card split), and setTaskPr only ever WRITES a
// number, so nothing could clear a stale link — the board kept saying "review
// (PR #334)" forever. clearTaskPr is the manual way out; deliberately narrow
// (pr only, state/repo untouched — the next lane is the reviewer/human's call).
describe("clearTaskPr (kobo-507 — unlink a stale/superseded PR)", () => {
  test("clears pr, leaves state and repo untouched, requires a reason", () => {
    const t = addTask({ company: "pgw", title: "superseded work", by: "eq3", assignee: "patchwork" });
    setTaskPr("pgw", t.id, 334, "patchwork", "meganechan/maw-js");
    const cleared = clearTaskPr("pgw", t.id, "eq3", "PR #334 closed, superseded by pgw-9/pgw-10")!;
    expect(cleared.pr).toBeUndefined();
    expect(cleared.state).toBe("review"); // untouched — not this function's call to make
    expect(cleared.repo).toBe("meganechan/maw-js"); // untouched — still a true historical fact
  });

  test("empty/whitespace-only reason → refused, pr NOT cleared", () => {
    const t = addTask({ company: "pgw", title: "x", by: "eq3" });
    setTaskPr("pgw", t.id, 10, "eq3");
    expect(clearTaskPr("pgw", t.id, "eq3", "")).toBeNull();
    expect(clearTaskPr("pgw", t.id, "eq3", "   ")).toBeNull();
    expect(readTask("pgw", t.id)!.pr).toBe(10); // still linked — refusal didn't half-apply
  });

  test("idempotent — clearing an already-unset pr is a no-op, not an error", () => {
    const t = addTask({ company: "pgw", title: "never had a pr", by: "eq3" });
    const result = clearTaskPr("pgw", t.id, "eq3", "just in case");
    expect(result?.pr).toBeUndefined();
    expect(result?.id).toBe(t.id); // still returns the task, doesn't refuse
  });

  test("missing card → null (no throw)", () => {
    expect(clearTaskPr("pgw", "pgw-999", "eq3", "why")).toBeNull();
  });

  test("emits a worklog entry naming the prior PR + reason (audit trail — Principle 1)", () => {
    const t = addTask({ company: "pgw", title: "audited", by: "eq3" });
    setTaskPr("pgw", t.id, 42, "eq3");
    clearTaskPr("pgw", t.id, "eq3", "superseded");
    const wl = readWorklog("pgw");
    const entry = wl.find((e) => e.task === t.id && String((e as any).summary ?? "").includes("unlinked"));
    expect(entry).toBeTruthy();
    expect(String((entry as any).summary)).toContain("#42");
    expect(String((entry as any).summary)).toContain("superseded");
  });
});

describe("escalateCrewGate (kobo-546) — the ONLY way crewGate turns true outside a crew sign/dispatch", () => {
  test("a plain 1-tier card gets escalated to 2-tier, reason lands on the card's own notes", () => {
    const t = addTask({ company: "kobo", title: "c", by: "eq3" });
    expect(requiredSignTiers(t)).toEqual(["head"]);
    const escalated = escalateCrewGate("kobo", t.id, "eq3", "touches sensitive path (route.ts): src/core/tasks/route.ts");
    expect(escalated?.crewGate).toBe(true);
    expect(requiredSignTiers(escalated!)).toEqual(["crew", "head"]);
    expect(missingSignTiers(escalated!)).toEqual(["crew", "head"]);
    const lastNote = escalated!.notes?.[escalated!.notes!.length - 1];
    expect(lastNote?.text).toContain("escalated to 2-tier");
    expect(lastNote?.text).toContain("route.ts");
  });

  test("ONE-WAY RATCHET: calling escalateCrewGate on an already-crewGate:true card is a no-op — no duplicate note, no re-write", () => {
    const t = addTask({ company: "kobo", title: "c", by: "eq3", crewGate: true });
    const notesBefore = t.notes?.length ?? 0;
    const result = escalateCrewGate("kobo", t.id, "eq3", "should not fire");
    expect(result?.crewGate).toBe(true);
    expect(result?.notes?.length ?? 0).toBe(notesBefore); // no new note — already 2-tier, nothing to log again
  });

  test("unknown card → null, no throw", () => {
    expect(escalateCrewGate("kobo", "kobo-does-not-exist", "eq3", "x")).toBeNull();
  });

  // kobo-546 rule 8: "การ์ดที่ 2 ชั้นเซ็นไปแล้ว ห้าม ถูกดาวน์เกรดเป็น 1 ชั้น ไม่ว่าด้วยกลไกใด" —
  // this is a STRUCTURAL guarantee (no function in this file ever writes `crewGate =
  // false`), not just a behavioral one. A source-string check pins it: if a future
  // patch adds ANY downgrade path, this test catches it even if the new path's own
  // tests happen to be green.
  test("STRUCTURAL: no downgrade path exists anywhere in store.ts (crewGate is never set back to false)", () => {
    const src = readFileSync(join(import.meta.dir, "store.ts"), "utf8");
    // real assignment targets are always `<something>.crewGate = ...` — the leading
    // dot keeps this from tripping on prose that mentions "crewGate = false" (this
    // very file's own comment above escalateCrewGate does, explaining the invariant).
    expect(src).not.toMatch(/\.crewGate\s*=\s*false/);
    expect(src).not.toContain("delete task.crewGate");
  });
});

describe("reclassifyAndEscalate (kobo-546) — merge-time wins over the PR-open stamp", () => {
  test("Given a card stamped 1-tier at PR-open, When the CURRENT diff touches a sensitive path at merge-time, Then it escalates to 2-tier — the exact rebase-shaped gap kobo-544 closed for sha, same shape for tier-count", () => {
    const t = addTask({ company: "kobo", title: "c", by: "eq3" }); // PR-open stamp: no sensitive path seen, stays 1-tier
    expect(requiredSignTiers(t)).toEqual(["head"]);

    const merged = reclassifyAndEscalate("kobo", t.id, "eq3", [{ path: "src/core/tasks/store.ts", additions: 1, deletions: 1 }], "merge-time");
    expect(merged?.crewGate).toBe(true);
    expect(requiredSignTiers(readTask("kobo", t.id)!)).toEqual(["crew", "head"]);
  });

  test("nothing to escalate when the diff stays safe — returns null, card stays 1-tier", () => {
    const t = addTask({ company: "kobo", title: "c", by: "eq3" });
    const result = reclassifyAndEscalate("kobo", t.id, "eq3", [{ path: "src/vendor/mpr-plugins/whoami/index.ts", additions: 1, deletions: 0 }], "merge-time");
    expect(result).toBeNull();
    expect(requiredSignTiers(readTask("kobo", t.id)!)).toEqual(["head"]);
  });

  test("fail-closed: an unreadable diff (null) at merge-time escalates too, not just at PR-open", () => {
    const t = addTask({ company: "kobo", title: "c", by: "eq3" });
    const merged = reclassifyAndEscalate("kobo", t.id, "eq3", null, "merge-time");
    expect(merged?.crewGate).toBe(true);
  });

  // eq3 head review (PR#359 c1): this test proves reclassifyAndEscalate ITSELF
  // performs a real store write, not just a return value — it calls the function
  // directly. It does NOT prove the merge CLI's call site (task/index.ts:941,
  // stage "merge-time") is ever reached: deleting that call site leaves this
  // function fully intact and this test green either way. The bind-site proof
  // — a behavioral test that goes through the actual `merge` command and would
  // go red if the merge-time call were removed — lives in
  // test/isolated/plugin-task-sign-merge.test.ts (kobo-546 REWORK, "merge-time
  // reclassify is a CALL SITE, not just a function").
  test("mutation-anchor: escalation must be a REAL store write, not just a return value — readTask from a fresh handle sees crewGate too", () => {
    const t = addTask({ company: "kobo", title: "c", by: "eq3" });
    reclassifyAndEscalate("kobo", t.id, "eq3", [{ path: ".github/workflows/ci.yml", additions: 1, deletions: 0 }], "pr-open");
    const fresh = readTask("kobo", t.id)!; // separate read, not the in-memory object escalateCrewGate returned
    expect(fresh.crewGate).toBe(true);
  });
});
