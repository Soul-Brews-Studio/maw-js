import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  cmdTeamTaskAdd,
  cmdTeamTaskAssign,
  cmdTeamTaskDelete,
  cmdTeamTaskDeleteAll,
  cmdTeamTaskDone,
  cmdTeamTaskList,
} from "../../src/vendor/mpr-plugins/team/task-ops";

let configDir = "";
let logs: string[] = [];
const originalLog = console.log;
const originalConfigDir = process.env.MAW_CONFIG_DIR;
const originalStateDir = process.env.MAW_STATE_DIR;

function tasksDir(team: string) {
  return join(configDir, "teams", team, "tasks");
}

function counterPath(team: string) {
  return join(tasksDir(team), "_counter.json");
}

function taskPath(team: string, id: number) {
  return join(tasksDir(team), `${id}.json`);
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "maw-team-task-ops-"));
  process.env.MAW_CONFIG_DIR = configDir;
  process.env.MAW_STATE_DIR = configDir;
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalConfigDir;
  if (originalStateDir === undefined) delete process.env.MAW_STATE_DIR;
  else process.env.MAW_STATE_DIR = originalStateDir;
  rmSync(configDir, { recursive: true, force: true });
  console.log = originalLog;
});

describe("team task ops isolated coverage", () => {
  test("creates tasks, increments ids, and persists optional fields", () => {
    const created = cmdTeamTaskAdd("qa", "cover branches", { description: "important", assign: "oracle" });
    const second = cmdTeamTaskAdd("qa", "ship release");

    expect(created.id).toBe(1);
    expect(created.status).toBe("pending");
    expect(created.description).toBe("important");
    expect(created.assignee).toBe("oracle");
    expect(second.id).toBe(2);

    const onDisk = JSON.parse(readFileSync(taskPath("qa", 1), "utf-8"));
    expect(onDisk.subject).toBe("cover branches");
    expect(JSON.parse(readFileSync(counterPath("qa"), "utf-8"))).toEqual({ next: 3 });
    expect(logs.at(-1)).toContain("task #2 created: ship release");
  });

  test("recovers from a corrupt counter file", () => {
    mkdirSync(tasksDir("broken"), { recursive: true });
    writeFileSync(counterPath("broken"), "{ definitely-not-json");

    const created = cmdTeamTaskAdd("broken", "heal counter");

    expect(created.id).toBe(1);
    expect(JSON.parse(readFileSync(counterPath("broken"), "utf-8"))).toEqual({ next: 2 });
  });

  test("lists no tasks when the team directory is missing or empty", () => {
    expect(cmdTeamTaskList("missing-team")).toEqual([]);
    expect(logs.at(-1)).toContain('no tasks for team "missing-team"');

    mkdirSync(tasksDir("empty-team"), { recursive: true });
    logs = [];

    expect(cmdTeamTaskList("empty-team")).toEqual([]);
    expect(logs.at(-1)).toContain('no tasks for team "empty-team"');
  });

  test("lists sorted tasks, filters corrupt json, and includes assignees", () => {
    mkdirSync(tasksDir("sort-team"), { recursive: true });
    writeFileSync(taskPath("sort-team", 3), JSON.stringify({
      id: 3,
      subject: "third",
      status: "completed",
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    }, null, 2));
    writeFileSync(taskPath("sort-team", 1), JSON.stringify({
      id: 1,
      subject: "first",
      status: "pending",
      assignee: "alice",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }, null, 2));
    writeFileSync(taskPath("sort-team", 2), "{ nope");
    writeFileSync(counterPath("sort-team"), JSON.stringify({ next: 4 }));

    const listed = cmdTeamTaskList("sort-team");

    expect(listed.map((task) => task.id)).toEqual([1, 3]);
    expect(logs[0]).toContain('tasks for team "sort-team" (2):');
    expect(logs[1]).toContain("#1");
    expect(logs[1]).toContain("alice");
    expect(logs[2]).toContain("#3");
  });

  test("marks tasks done and gracefully handles missing or corrupt task files", () => {
    expect(cmdTeamTaskDone("ops", 9)).toBeNull();
    expect(logs.at(-1)).toContain('task #9 not found in team "ops"');

    logs = [];
    mkdirSync(tasksDir("ops"), { recursive: true });
    writeFileSync(taskPath("ops", 7), JSON.stringify({
      id: 7,
      subject: "finish docs",
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }, null, 2));

    const done = cmdTeamTaskDone("ops", 7);

    expect(done?.status).toBe("completed");
    expect(logs.at(-1)).toContain("task #7 marked completed");

    writeFileSync(taskPath("ops", 8), "{ broken");
    expect(cmdTeamTaskDone("ops", 8)).toBeNull();
  });

  test("assigns tasks and updates status", () => {
    expect(cmdTeamTaskAssign("ops", 4, "bob")).toBeNull();
    expect(logs.at(-1)).toContain('task #4 not found in team "ops"');

    logs = [];
    mkdirSync(tasksDir("ops"), { recursive: true });
    writeFileSync(taskPath("ops", 5), JSON.stringify({
      id: 5,
      subject: "triage flakes",
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }, null, 2));

    const assigned = cmdTeamTaskAssign("ops", 5, "bob");

    expect(assigned?.assignee).toBe("bob");
    expect(assigned?.status).toBe("in_progress");
    expect(logs.at(-1)).toContain("task #5 assigned to bob");
  });

  test("deletes single tasks and whole task directories", () => {
    expect(cmdTeamTaskDelete("cleanup", 1)).toBe(false);
    expect(logs.at(-1)).toContain('task #1 not found in team "cleanup"');

    logs = [];
    const created = cmdTeamTaskAdd("cleanup", "remove temp");
    expect(existsSync(taskPath("cleanup", created.id))).toBe(true);

    expect(cmdTeamTaskDelete("cleanup", created.id)).toBe(true);
    expect(existsSync(taskPath("cleanup", created.id))).toBe(false);
    expect(logs.at(-1)).toContain(`task #${created.id} deleted`);

    cmdTeamTaskAdd("cleanup", "recreate");
    expect(existsSync(tasksDir("cleanup"))).toBe(true);
    cmdTeamTaskDeleteAll("cleanup");
    expect(existsSync(tasksDir("cleanup"))).toBe(false);

    cmdTeamTaskDeleteAll("cleanup");
    expect(existsSync(tasksDir("cleanup"))).toBe(false);
  });
});
