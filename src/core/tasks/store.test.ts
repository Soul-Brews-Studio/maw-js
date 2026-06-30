import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  addTask,
  claimTask,
  completeTask,
  listTasks,
  nextTaskId,
  readTask,
  startTask,
  taskFilePath,
  tasksDir,
  tryCreateTaskRecord,
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
