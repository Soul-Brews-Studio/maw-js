import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");

type WindowInfo = { index: number; name: string; active?: boolean };
type SessionInfo = { name: string; windows: WindowInfo[] };

let sessions: SessionInfo[] = [];
let execCalls: string[] = [];
let execFailures: Record<string, Error> = {};

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  listSessions: async () => sessions,
  hostExec: async (command: string) => {
    execCalls.push(command);
    for (const [needle, error] of Object.entries(execFailures)) {
      if (command.includes(needle)) throw error;
    }
    if (command.includes("display-message")) return "/repo/worktree\n";
    return "";
  },
}));

const { default: takeHandler } = await import("../../src/vendor/mpr-plugins/take/index.ts?plugin-take-standalone");
const { cmdTake } = await import("../../src/vendor/mpr-plugins/take/impl.ts?plugin-take-standalone");

beforeEach(() => {
  sessions = [
    { name: "neo", windows: [{ index: 1, name: "main" }, { index: 2, name: "scratch" }] },
    { name: "pulse", windows: [{ index: 1, name: "home" }] },
  ];
  execCalls = [];
  execFailures = {};
});

describe("take plugin standalone boundary (#2113)", () => {
  test("imports only SDK plus plugin-local dependencies", () => {
    for (const rel of ["index.ts", "impl.ts"]) {
      const source = readFileSync(join(root, "src/vendor/mpr-plugins/take", rel), "utf8");
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|lib|config|plugin)(?:\/|")/);
      expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
    }
    const combined = ["index.ts", "impl.ts"]
      .map((rel) => readFileSync(join(root, "src/vendor/mpr-plugins/take", rel), "utf8"))
      .join("\n");
    expect(combined).toContain('from "maw-js/sdk"');
    expect(combined).toContain("listSessions");
    expect(combined).toContain("hostExec");
  });

  test("moves a named source window into an existing target session", async () => {
    await cmdTake("neo:scratch", "pulse");

    expect(execCalls).toEqual([
      "tmux display-message -t 'neo:scratch' -p '#{pane_current_path}'",
      "tmux move-window -s 'neo:scratch' -t 'pulse:'",
    ]);
  });

  test("splits into a new session and resolves tmux display suffixes", async () => {
    await cmdTake("neo:scratch-");

    expect(execCalls).toEqual([
      "tmux new-session -d -s 'scratch'",
      "tmux display-message -t 'neo:scratch' -p '#{pane_current_path}'",
      "tmux move-window -s 'neo:scratch' -t 'scratch:'",
      "tmux kill-window -t 'scratch:1' 2>/dev/null",
    ]);
  });

  test("handler validates CLI/API arguments and returns movement output", async () => {
    const missingCli = await takeHandler({ source: "cli", args: [] } as any);
    expect(missingCli).toEqual({ ok: false, error: "usage: maw take <session>:<window> [target-session]" });

    const missingApi = await takeHandler({ source: "api", args: {} } as any);
    expect(missingApi).toEqual({ ok: false, error: "source is required" });

    const ok = await takeHandler({ source: "api", args: { source: "neo:2", target: "pulse" } } as any);
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain("neo:scratch → pulse");
    expect(ok.output).toContain("cwd: /repo/worktree");
  });

  test("reports missing sessions and windows without moving", async () => {
    await expect(cmdTake("ghost:main", "pulse")).rejects.toThrow("session 'ghost' not found");
    expect(execCalls).toEqual([]);

    await expect(cmdTake("neo:ghost", "pulse")).rejects.toThrow("window 'ghost' not found in session 'neo'");
    expect(execCalls).toEqual([]);
  });
});
