/** Targeted isolated coverage for src/vendor/mpr-plugins/restart/impl.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let sessions: Array<{ name: string; windows: Array<{ name: string }> }> = [];
let killedSessions: string[] = [];
let sleepCalls = 0;
let wakeAllCalls = 0;
let execCalls: string[] = [];
let execFailures: Record<string, number> = {};
let ghqResult: string | null = null;
let logs: string[] = [];

const originalLog = console.log;
const originalArgv = [...process.argv];

class MockTmux {
  async killSession(name: string) {
    killedSessions.push(name);
  }
}

mock.module("maw-js/sdk", () => ({
  listSessions: async () => sessions,
  Tmux: MockTmux,
}));

mock.module("maw-js/commands/shared/fleet", () => ({
  cmdSleep: async () => { sleepCalls += 1; },
  cmdWakeAll: async () => { wakeAllCalls += 1; },
}));

mock.module("child_process", () => ({
  execSync: (cmd: string, opts?: unknown) => {
    execCalls.push(cmd);
    expect(opts).toBeDefined();

    const remainingFailures = execFailures[cmd] ?? 0;
    if (remainingFailures > 0) {
      execFailures[cmd] = remainingFailures - 1;
      throw new Error(`mock exec failed: ${cmd}`);
    }

    if (cmd === "maw --version") return "v9.9.9-test\n";
    return "";
  },
}));

mock.module("maw-js/core/ghq", () => ({
  ghqFindSync: (suffix: string) => {
    expect(suffix).toBe("/Soul-Brews-Studio/maw-js");
    return ghqResult;
  },
}));

const { cmdRestart } = await import("../../src/vendor/mpr-plugins/restart/impl.ts?restart-impl-coverage");

beforeEach(() => {
  sessions = [];
  killedSessions = [];
  sleepCalls = 0;
  wakeAllCalls = 0;
  execCalls = [];
  execFailures = {};
  ghqResult = null;
  logs = [];
  process.argv.splice(0, process.argv.length, ...originalArgv.filter(arg => arg !== "--help" && arg !== "-h"));
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
});

afterEach(() => {
  console.log = originalLog;
  process.argv.splice(0, process.argv.length, ...originalArgv);
});

describe("restart impl isolated coverage", () => {
  test("prints help without touching tmux, update, sleep, or wake seams", async () => {
    await cmdRestart({ help: true });

    expect(logs.join("\n")).toContain("usage: maw restart");
    expect(killedSessions).toEqual([]);
    expect(execCalls).toEqual([]);
    expect(sleepCalls).toBe(0);
    expect(wakeAllCalls).toBe(0);
  });

  test("honors process argv help guard as defense in depth", async () => {
    process.argv.push("--help");

    await cmdRestart();

    expect(logs.join("\n")).toContain("--no-update");
    expect(execCalls).toEqual([]);
    expect(sleepCalls).toBe(0);
    expect(wakeAllCalls).toBe(0);
  });

  test("kills only stale sessions, skips update, then sleeps and wakes fleet", async () => {
    sessions = [
      { name: "01-live", windows: [{ name: "codex" }] },
      { name: "old-view", windows: [{ name: "vim" }] },
      { name: "maw-pty-123", windows: [{ name: "zsh" }] },
      { name: "bash-only", windows: [{ name: "bash" }, { name: "bash" }] },
    ];

    await cmdRestart({ noUpdate: true });

    expect(killedSessions).toEqual(["old-view", "maw-pty-123", "bash-only"]);
    expect(execCalls).toEqual([]);
    expect(sleepCalls).toBe(1);
    expect(wakeAllCalls).toBe(1);
    const output = logs.join("\n");
    expect(output).toContain("Cleaning 3 stale sessions");
    expect(output).toContain("Update skipped (--no-update)");
    expect(output).toContain("restart complete");
  });

  test("updates the requested ref and reports version without SDK relink when checkout is absent", async () => {
    await cmdRestart({ ref: "alpha" });

    expect(execCalls).toEqual([
      "bun add -g github:Soul-Brews-Studio/maw-js#alpha",
      "maw --version",
    ]);
    expect(logs.join("\n")).toContain("Updating maw-js (alpha)");
    expect(logs.join("\n")).toContain("→ v9.9.9-test");
    expect(sleepCalls).toBe(1);
    expect(wakeAllCalls).toBe(1);
  });

  test("clears stale global refs and retries when the first install attempt fails", async () => {
    execFailures["bun add -g github:Soul-Brews-Studio/maw-js#feature-ref"] = 1;

    await cmdRestart({ ref: "feature-ref" });

    expect(execCalls).toEqual([
      "bun add -g github:Soul-Brews-Studio/maw-js#feature-ref",
      "bun remove -g maw",
      "bun add -g github:Soul-Brews-Studio/maw-js#feature-ref",
      "maw --version",
    ]);
    expect(logs.join("\n")).toContain("first install attempt failed");
    expect(sleepCalls).toBe(1);
    expect(wakeAllCalls).toBe(1);
  });

  test("aborts before sleep and wake when install retry also fails", async () => {
    execFailures["bun add -g github:Soul-Brews-Studio/maw-js#broken-ref"] = 2;

    await cmdRestart({ ref: "broken-ref" });

    expect(execCalls).toEqual([
      "bun add -g github:Soul-Brews-Studio/maw-js#broken-ref",
      "bun remove -g maw",
      "bun add -g github:Soul-Brews-Studio/maw-js#broken-ref",
    ]);
    expect(logs.join("\n")).toContain("update failed — manual recovery");
    expect(sleepCalls).toBe(0);
    expect(wakeAllCalls).toBe(0);
  });
});
