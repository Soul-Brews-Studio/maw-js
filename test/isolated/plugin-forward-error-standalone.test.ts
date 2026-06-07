import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const { cmdForwardError, parseForwardErrorArgs } = await import("../../src/vendor/mpr-plugins/forward-error/impl.ts?plugin-forward-error-standalone");
const { default: handler } = await import("../../src/vendor/mpr-plugins/forward-error/index.ts?plugin-forward-error-standalone");

const root = join(import.meta.dir, "../..");

describe("forward-error plugin standalone boundary (#2511)", () => {
  test("has a standalone plugin boundary", () => {
    const imports = expectStandalonePluginBoundary({ plugin: "forward-error", root });
    expect(imports.map((record) => record.spec)).toContain("maw-js/sdk");
    expect(imports.map((record) => record.spec)).toContain("node:child_process");
  });

  test("parses target and last-line flags", () => {
    expect(parseForwardErrorArgs([])).toEqual({});
    expect(parseForwardErrorArgs(["--to", "doctor-alpha", "--last", "12"])).toEqual({ target: "doctor-alpha", last: 12 });
    expect(parseForwardErrorArgs(["--to=doctor-alpha", "--last=9"])).toEqual({ target: "doctor-alpha", last: 9 });
    expect(() => parseForwardErrorArgs(["--last", "nope"])).toThrow("invalid --last value");
    expect(() => parseForwardErrorArgs(["--bogus"])).toThrow("unknown argument");
  });

  test("captures current pane and forwards structured message to configured target", async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options?: Record<string, unknown> }> = [];
    const message = await cmdForwardError({}, {
      loadConfig: () => ({ errorForward: { target: "doctor-alpha" } } as any),
      cwd: () => "/repo/worktree",
      now: () => new Date("2026-06-08T02:03:04.000Z"),
      env: { MAW_LAST_EXIT_CODE: "42" },
      spawnSync: (command: string, args: string[], options?: Record<string, unknown>) => {
        spawnCalls.push({ command, args, options });
        if (command === "tmux") return { status: 0, stdout: "line 1\nline 2\n" };
        if (command === "maw") return { status: 0, stdout: "delivered" };
        return { status: 1, stderr: "unexpected" };
      },
    });

    expect(message).toEqual({
      error: "line 1\nline 2",
      cwd: "/repo/worktree",
      exitCode: 42,
      timestamp: "2026-06-08T02:03:04.000Z",
    });
    expect(spawnCalls[0]).toMatchObject({ command: "tmux", args: ["capture-pane", "-p", "-S", "-30"] });
    expect(spawnCalls[1].command).toBe("maw");
    expect(spawnCalls[1].args.slice(0, 2)).toEqual(["hey", "doctor-alpha"]);
    expect(JSON.parse(spawnCalls[1].args[2])).toEqual(message);
  });

  test("CLI options override target and line count", async () => {
    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    await cmdForwardError({ target: "doctor-beta", last: 5 }, {
      loadConfig: () => ({ errorForward: { target: "doctor-alpha" } } as any),
      cwd: () => "/repo",
      now: () => new Date("2026-06-08T02:03:04.000Z"),
      env: {},
      spawnSync: (command: string, args: string[]) => {
        spawnCalls.push({ command, args });
        return command === "tmux" ? { status: 0, stdout: "boom" } : { status: 0, stdout: "delivered" };
      },
    });

    expect(spawnCalls[0]).toEqual({ command: "tmux", args: ["capture-pane", "-p", "-S", "-5"] });
    expect(spawnCalls[1].args.slice(0, 2)).toEqual(["hey", "doctor-beta"]);
  });

  test("reports tmux and maw failures", async () => {
    await expect(cmdForwardError({}, {
      loadConfig: () => ({} as any),
      cwd: () => "/repo",
      now: () => new Date("2026-06-08T02:03:04.000Z"),
      env: {},
      spawnSync: (command: string) => command === "tmux"
        ? { status: 1, stderr: "not in tmux" }
        : { status: 0, stdout: "delivered" },
    })).rejects.toThrow("tmux capture-pane failed (exit 1): not in tmux");

    await expect(cmdForwardError({}, {
      loadConfig: () => ({} as any),
      cwd: () => "/repo",
      now: () => new Date("2026-06-08T02:03:04.000Z"),
      env: {},
      spawnSync: (command: string) => command === "tmux"
        ? { status: 0, stdout: "boom" }
        : { status: 7, stderr: "no route" },
    })).rejects.toThrow("maw hey failed (exit 7): no route");
  });

  test("handler surfaces parse errors through InvokeResult", async () => {
    const result = await handler({ source: "cli", args: ["--last", "bad"] } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid --last value");
  });
});
