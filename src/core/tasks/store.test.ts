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
  claimTask,
  completeTask,
  DEFAULT_ARCHIVE_DAYS,
  dependencyBlock,
  isBlockedByDependency,
  isOnBoard,
  listArchivedTasks,
  listTasks,
  nextTaskId,
  parentStateResolver,
  readTask,
  startTask,
  taskFilePath,
  tasksDir,
  tryCreateTaskRecord,
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
    expect(blockedAfter).toBe(false); // parent done → child free, no stored state touched
  });
});
