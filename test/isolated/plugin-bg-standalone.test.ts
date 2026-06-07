import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const pluginRoot = join(root, "src/vendor/mpr-plugins/bg");

type SpawnSyncResult = { status?: number | null; stdout?: string; stderr?: string; error?: NodeJS.ErrnoException };
let syncCalls: Array<{ cmd: string; args: string[] }>;
let syncQueue: SpawnSyncResult[];
let asyncCalls: Array<{ cmd: string; args: string[]; opts: unknown }>;
let asyncError: Error | null;
let asyncExitCode: number;

mock.module("node:child_process", () => ({
  spawnSync: (cmd: string, args: string[]) => {
    syncCalls.push({ cmd, args });
    return syncQueue.shift() ?? { status: 0, stdout: "", stderr: "" };
  },
  spawn: (cmd: string, args: string[], opts: unknown) => {
    asyncCalls.push({ cmd, args, opts });
    const child = new EventEmitter();
    queueMicrotask(() => {
      if (asyncError) child.emit("error", asyncError);
      else child.emit("exit", asyncExitCode);
    });
    return child;
  },
}));

const bg = await import("../../src/vendor/mpr-plugins/bg/src/index.ts?plugin-bg-standalone");

function listSessionsOut(created = 1_700_000_000) {
  return [
    `maw-bg-build-a1b2\t${created}\tnode`,
    `maw-bg-done-c3d4\t${created - 100_000}\tsleep`,
    `regular\t${created}\tzsh`,
    "",
  ].join("\n");
}

beforeEach(() => {
  syncCalls = [];
  syncQueue = [];
  asyncCalls = [];
  asyncError = null;
  asyncExitCode = 0;
});

describe("bg plugin standalone boundary (#2186)", () => {
  test("has no direct maw-js core/shared/lib/plugin imports", () => {
    const files = [
      "src/index.ts",
      "src/impl.ts",
      "src/internal/parse-flags.ts",
      "src/internal/user-error.ts",
    ];
    for (const file of files) {
      const source = readFileSync(join(pluginRoot, file), "utf8");
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|lib|plugin|sdk)(?:\/|\")/);
      expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+\.\.\//);
    }
  });

  test("spawns detached tmux sessions with derived and explicit slugs", async () => {
    syncQueue = [
      { status: 1, stdout: "", stderr: "missing" },
      { status: 0, stdout: "", stderr: "" },
    ];

    const result = await bg.default({ source: "cli", args: ["npm", "test", "--name", "tests"] });

    expect(result).toEqual({ ok: true, output: "tests\tmaw-bg-tests" });
    expect(syncCalls).toEqual([
      { cmd: "tmux", args: ["has-session", "-t", "maw-bg-tests"] },
      {
        cmd: "tmux",
        args: [
          "new-session", "-d", "-s", "maw-bg-tests", "-n", "bg",
          "/bin/sh", "-c", expect.stringContaining("npm test; rc=$?"),
        ],
      },
    ]);
  });

  test("lists, tails, kills, and gc sessions through tmux without host imports", async () => {
    const now = Date.now;
    Date.now = () => 1_700_100_000_000;
    try {
      syncQueue = [
        { status: 0, stdout: listSessionsOut(), stderr: "" },
        { status: 0, stdout: "building\n", stderr: "" },
        { status: 0, stdout: "[done — exit 0]\n", stderr: "" },
      ];
      const listed = await bg.default({ source: "cli", args: ["ls", "--json"] });
      expect(listed.ok).toBe(true);
      expect(JSON.parse(listed.output!)).toMatchObject([
        { slug: "build-a1b2", status: "running", lastLine: "building" },
        { slug: "done-c3d4", status: "done", lastLine: "[done — exit 0]" },
      ]);

      syncQueue = [
        { status: 0, stdout: listSessionsOut(), stderr: "" },
        { status: 0, stdout: "building\n", stderr: "" },
        { status: 0, stdout: "done\n", stderr: "" },
        { status: 0, stdout: "line1\nline2\n", stderr: "" },
      ];
      await expect(bg.default({ source: "cli", args: ["tail", "a1b2", "--lines", "2"] })).resolves.toMatchObject({
        ok: true,
        output: "line1\nline2",
      });

      syncQueue = [
        { status: 0, stdout: listSessionsOut(), stderr: "" },
        { status: 0, stdout: "building\n", stderr: "" },
        { status: 0, stdout: "done\n", stderr: "" },
        { status: 0, stdout: "", stderr: "" },
      ];
      await expect(bg.default({ source: "cli", args: ["kill", "done"] })).resolves.toEqual({
        ok: true,
        output: "killed: done-c3d4",
      });
      expect(syncCalls.at(-1)).toEqual({ cmd: "tmux", args: ["kill-session", "-t", "maw-bg-done-c3d4"] });

      syncQueue = [
        { status: 0, stdout: listSessionsOut(), stderr: "" },
        { status: 0, stdout: "building\n", stderr: "" },
        { status: 0, stdout: "done\n", stderr: "" },
      ];
      await expect(bg.default({ source: "cli", args: ["gc", "--dry-run", "--older-than", "1h"] })).resolves.toMatchObject({
        ok: true,
        output: expect.stringContaining("would reap: done-c3d4"),
      });
    } finally {
      Date.now = now;
    }
  });

  test("attach switches inside tmux and exposes user-facing validation errors", async () => {
    const oldTmux = process.env.TMUX;
    process.env.TMUX = "/tmp/tmux.sock,1,0";
    try {
      syncQueue = [
        { status: 0, stdout: listSessionsOut(), stderr: "" },
        { status: 0, stdout: "building\n", stderr: "" },
        { status: 0, stdout: "done\n", stderr: "" },
      ];
      const attached = await bg.default({ source: "cli", args: ["attach", "build"] });
      expect(attached).toEqual({ ok: true, exitCode: 0 });
      expect(asyncCalls).toEqual([{ cmd: "tmux", args: ["switch-client", "-t", "maw-bg-build-a1b2"], opts: { stdio: "inherit" } }]);
    } finally {
      if (oldTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = oldTmux;
    }

    await expect(bg.default({ source: "cli", args: ["--name", "Bad_Name", "echo", "x"] })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("invalid --name"),
      exitCode: 1,
    });
    await expect(bg.default({ source: "cli", args: ["kill"] })).resolves.toMatchObject({
      ok: false,
      error: "Error: bg kill: missing <slug> (or --all)",
    });
  });
});
