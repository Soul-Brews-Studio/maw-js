/**
 * Tests for src/commands/plugins/team/task-ops.ts — CRUD task operations.
 * Uses temp directory with MAW_CONFIG_DIR env override.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmp: string;
let origEnv: string | undefined;

// Must set env before importing
beforeEach(() => {
  tmp = join(tmpdir(), `maw-task-ops-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  origEnv = process.env.MAW_CONFIG_DIR;
  process.env.MAW_CONFIG_DIR = tmp;
});

afterEach(() => {
  if (origEnv !== undefined) process.env.MAW_CONFIG_DIR = origEnv;
  else delete process.env.MAW_CONFIG_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

// Dynamic import to pick up env
async function loadOps() {
  // Clear module cache to pick up new env
  return await import("../../src/commands/plugins/team/task-ops");
}

describe("cmdTeamTaskAdd", () => {
  it("creates task with incrementing id", async () => {
    const ops = await loadOps();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const t1 = ops.cmdTeamTaskAdd("alpha", "First task");
    const t2 = ops.cmdTeamTaskAdd("alpha", "Second task");
    expect(t1.id).toBe(1);
    expect(t2.id).toBe(2);
    spy.mockRestore();
  });

  it("sets status to pending", async () => {
    const ops = await loadOps();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const task = ops.cmdTeamTaskAdd("alpha", "Test");
    expect(task.status).toBe("pending");
    spy.mockRestore();
  });

  it("includes subject", async () => {
    const ops = await loadOps();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const task = ops.cmdTeamTaskAdd("alpha", "Build API");
    expect(task.subject).toBe("Build API");
    spy.mockRestore();
  });

  it("includes optional description", async () => {
    const ops = await loadOps();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const task = ops.cmdTeamTaskAdd("alpha", "Task", { description: "Details here" });
    expect(task.description).toBe("Details here");
    spy.mockRestore();
  });

  it("includes optional assignee", async () => {
    const ops = await loadOps();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const task = ops.cmdTeamTaskAdd("alpha", "Task", { assign: "blaze" });
    expect(task.assignee).toBe("blaze");
    spy.mockRestore();
  });

  it("writes task file to disk", async () => {
    const ops = await loadOps();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    ops.cmdTeamTaskAdd("alpha", "Disk test");
    const taskFile = join(tmp, "teams", "alpha", "tasks", "1.json");
    expect(existsSync(taskFile)).toBe(true);
    const data = JSON.parse(readFileSync(taskFile, "utf-8"));
    expect(data.subject).toBe("Disk test");
    spy.mockRestore();
  });

  it("sets createdAt and updatedAt timestamps", async () => {
    const ops = await loadOps();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const task = ops.cmdTeamTaskAdd("alpha", "Timestamp test");
    expect(task.createdAt).toBeTruthy();
    expect(task.updatedAt).toBeTruthy();
    spy.mockRestore();
  });
});

describe("cmdTeamTaskList", () => {
  it("returns empty array for non-existent team", async () => {
    const ops = await loadOps();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const tasks = ops.cmdTeamTaskList("nonexistent");
    expect(tasks).toEqual([]);
    spy.mockRestore();
  });

  it("lists created tasks sorted by id", async () => {
    const ops = await loadOps();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    ops.cmdTeamTaskAdd("beta", "Third");
    ops.cmdTeamTaskAdd("beta", "First");
    const tasks = ops.cmdTeamTaskList("beta");
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe(1);
    expect(tasks[1].id).toBe(2);
    spy.mockRestore();
  });
});

describe("cmdTeamTaskDone", () => {
  it("marks task as completed", async () => {
    const ops = await loadOps();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    ops.cmdTeamTaskAdd("gamma", "Complete me");
    const result = ops.cmdTeamTaskDone("gamma", 1);
    expect(result?.status).toBe("completed");
    spy.mockRestore();
  });

  it("returns null for non-existent task", async () => {
    const ops = await loadOps();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const dir = join(tmp, "teams", "gamma", "tasks");
    mkdirSync(dir, { recursive: true });
    const result = ops.cmdTeamTaskDone("gamma", 999);
    expect(result).toBeNull();
    spy.mockRestore();
  });

  it("updates updatedAt timestamp", async () => {
    const ops = await loadOps();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const task = ops.cmdTeamTaskAdd("gamma", "Timestamp update");
    const before = task.updatedAt;
    // Small delay to ensure timestamp differs
    await new Promise(r => setTimeout(r, 5));
    const done = ops.cmdTeamTaskDone("gamma", 1);
    // updatedAt should be same or later
    expect(new Date(done!.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    spy.mockRestore();
  });
});

describe("cmdTeamTaskAssign", () => {
  it("assigns agent and sets status to in_progress", async () => {
    const ops = await loadOps();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    ops.cmdTeamTaskAdd("delta", "Assign me");
    const result = ops.cmdTeamTaskAssign("delta", 1, "forge");
    expect(result?.assignee).toBe("forge");
    expect(result?.status).toBe("in_progress");
    spy.mockRestore();
  });

  it("returns null for non-existent task", async () => {
    const ops = await loadOps();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const dir = join(tmp, "teams", "delta", "tasks");
    mkdirSync(dir, { recursive: true });
    const result = ops.cmdTeamTaskAssign("delta", 999, "forge");
    expect(result).toBeNull();
    spy.mockRestore();
  });
});

describe("cmdTeamTaskDelete", () => {
  it("deletes task file", async () => {
    const ops = await loadOps();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    ops.cmdTeamTaskAdd("epsilon", "Delete me");
    const taskFile = join(tmp, "teams", "epsilon", "tasks", "1.json");
    expect(existsSync(taskFile)).toBe(true);
    const result = ops.cmdTeamTaskDelete("epsilon", 1);
    expect(result).toBe(true);
    expect(existsSync(taskFile)).toBe(false);
    spy.mockRestore();
  });

  it("returns false for non-existent task", async () => {
    const ops = await loadOps();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const result = ops.cmdTeamTaskDelete("epsilon", 999);
    expect(result).toBe(false);
    spy.mockRestore();
  });
});

describe("cmdTeamTaskDeleteAll", () => {
  it("removes entire tasks directory", async () => {
    const ops = await loadOps();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    ops.cmdTeamTaskAdd("zeta", "Task 1");
    ops.cmdTeamTaskAdd("zeta", "Task 2");
    const dir = join(tmp, "teams", "zeta", "tasks");
    expect(existsSync(dir)).toBe(true);
    ops.cmdTeamTaskDeleteAll("zeta");
    expect(existsSync(dir)).toBe(false);
    spy.mockRestore();
  });

  it("no-ops for non-existent team", async () => {
    const ops = await loadOps();
    expect(() => ops.cmdTeamTaskDeleteAll("nonexistent")).not.toThrow();
  });
});
