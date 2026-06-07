import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const originalStateDir = process.env.MAW_STATE_DIR;
const originalConfigDir = process.env.MAW_CONFIG_DIR;
const root = join(tmpdir(), `maw-team-task-xdg-${process.pid}`);
const stateDir = join(root, "state");
const configDir = join(root, "config");

process.env.MAW_STATE_DIR = stateDir;
process.env.MAW_CONFIG_DIR = configDir;

const taskOps = await import("../../src/vendor/mpr-plugins/team/task-ops.ts?team-task-xdg");

describe("team task XDG state paths (#1818)", () => {
  beforeAll(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalStateDir === undefined) delete process.env.MAW_STATE_DIR;
    else process.env.MAW_STATE_DIR = originalStateDir;
    if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
    else process.env.MAW_CONFIG_DIR = originalConfigDir;
  });

  test("creates new team tasks under MAW_STATE_DIR instead of MAW_CONFIG_DIR", () => {
    const task = taskOps.cmdTeamTaskAdd("ops", "ship xdg slice", { assign: "codex" });

    const statePath = join(stateDir, "teams", "ops", "tasks", `${task.id}.json`);
    const legacyPath = join(configDir, "teams", "ops", "tasks", `${task.id}.json`);
    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
    expect(JSON.parse(readFileSync(statePath, "utf-8")).subject).toBe("ship xdg slice");
  });

  test("reads legacy config tasks and writes updates back to state", () => {
    const legacyDir = join(configDir, "teams", "legacy", "tasks");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "_counter.json"), JSON.stringify({ next: 8 }));
    writeFileSync(join(legacyDir, "7.json"), JSON.stringify({
      id: 7,
      subject: "old task",
      status: "pending",
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
    }));

    expect(taskOps.cmdTeamTaskList("legacy").map(t => t.id)).toEqual([7]);
    const done = taskOps.cmdTeamTaskDone("legacy", 7);

    expect(done?.status).toBe("completed");
    const migratedPath = join(stateDir, "teams", "legacy", "tasks", "7.json");
    expect(JSON.parse(readFileSync(migratedPath, "utf-8")).status).toBe("completed");
    expect(JSON.parse(readFileSync(join(legacyDir, "7.json"), "utf-8")).status).toBe("pending");
    expect(taskOps.cmdTeamTaskList("legacy").map(t => [t.id, t.status])).toEqual([[7, "completed"]]);

    expect(taskOps.cmdTeamTaskDelete("legacy", 7)).toBe(true);
    expect(existsSync(migratedPath)).toBe(false);
    expect(existsSync(join(legacyDir, "7.json"))).toBe(false);
  });
});
