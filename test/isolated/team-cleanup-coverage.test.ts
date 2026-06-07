import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const homeDir = mkdtempSync(join(tmpdir(), "maw-team-cleanup-"));
const taskOpsPath = import.meta.resolve("../../src/vendor/mpr-plugins/team/task-ops.ts");
const taskDeleteCalls: string[] = [];
let logs: string[] = [];
const originalLog = console.log;

mock.module("os", () => ({
  homedir: () => homeDir,
}));

mock.module(taskOpsPath, () => ({
  cmdTeamTaskDeleteAll: (teamName: string) => {
    taskDeleteCalls.push(teamName);
  },
}));

const { cmdTeamDelete } = await import(
  "../../src/vendor/mpr-plugins/team/team-cleanup.ts?team-cleanup-coverage"
);

beforeEach(() => {
  taskDeleteCalls.length = 0;
  logs = [];
  rmSync(join(homeDir, ".claude"), { recursive: true, force: true });
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterAll(() => {
  console.log = originalLog;
  rmSync(homeDir, { recursive: true, force: true });
});

describe("vendor team cleanup command", () => {
  test("clears tasks and reports an already-missing team directory", async () => {
    await cmdTeamDelete("ghost");

    expect(taskDeleteCalls).toEqual(["ghost"]);
    expect(logs.join("\n")).toContain("tasks cleared");
    expect(logs.join("\n")).toContain("team dir not found");
    expect(logs.join("\n")).toContain('team "ghost" deleted');
  });

  test("removes an existing team directory recursively", async () => {
    const teamDir = join(homeDir, ".claude", "teams", "ops");
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, "config.json"), JSON.stringify({ name: "ops" }), "utf-8");

    await cmdTeamDelete("ops");

    expect(taskDeleteCalls).toEqual(["ops"]);
    expect(existsSync(teamDir)).toBe(false);
    expect(logs.join("\n")).toContain("team dir removed:");
    expect(logs.join("\n")).toContain('team "ops" deleted');
  });
});
