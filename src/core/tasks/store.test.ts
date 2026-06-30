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
  taskFilePath,
  tasksDir,
} from "./store";
import { readWorklog } from "../worklog/store";

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

  test("addTask with assignee starts in-progress (delegation)", () => {
    const t = addTask({ company: "pgw", title: "fix bug", by: "eq3", assignee: "patchwork" });
    expect(t.state).toBe("in-progress");
    expect(t.assignee).toBe("patchwork");
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

  test("claim/complete on a missing id → null (no throw)", () => {
    expect(claimTask("pgw", "pgw-999", "x")).toBeNull();
    expect(completeTask("pgw", "pgw-999", "x")).toBeNull();
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
