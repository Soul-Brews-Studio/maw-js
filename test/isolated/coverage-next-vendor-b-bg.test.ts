import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as realChild from "node:child_process";

type SessionFixture = {
  created: number;
  paneCommand: string;
  tail: string;
};

const sessions = new Map<string, SessionFixture>();
let spawnExitCode: number | null = null;
let stdoutChunks: string[] = [];

const originalWrite = process.stdout.write;

function stripPrefix(target: string): string {
  return target.replace(/^maw-bg-/, "");
}

function mockSpawnSync(_cmd: string, args: string[] = []) {
  const [subcommand] = args;
  if (subcommand === "list-sessions") {
    return {
      status: 0,
      stdout: [...sessions.entries()]
        .map(([slug, session]) => `maw-bg-${slug}\t${session.created}\t${session.paneCommand}`)
        .join("\n"),
      stderr: "",
    };
  }
  if (subcommand === "capture-pane") {
    const target = args[args.indexOf("-t") + 1] ?? "";
    const slug = stripPrefix(target);
    const session = sessions.get(slug);
    return { status: session ? 0 : 1, stdout: session?.tail ?? "", stderr: session ? "" : "missing" };
  }
  if (subcommand === "has-session") {
    const slug = stripPrefix(args.at(-1) ?? "");
    return { status: sessions.has(slug) ? 0 : 1, stdout: "", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
}

function mockSpawn() {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("exit", spawnExitCode));
  return child;
}

mock.module("node:child_process", () => ({
  ...realChild,
  spawnSync: mockSpawnSync,
  spawn: mockSpawn,
}));

const { bgAttach, bgTailFollow } = await import("../../src/vendor/mpr-plugins/bg/src/impl.ts?coverage-next-vendor-b-bg");

beforeEach(() => {
  sessions.clear();
  spawnExitCode = null;
  stdoutChunks = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  delete process.env.TMUX;
});

afterEach(() => {
  process.stdout.write = originalWrite;
  delete process.env.TMUX;
});

describe("coverage-next vendor-b bg impl branches", () => {
  test("tail follow uses the default stdout writer before honoring an already-aborted signal", async () => {
    sessions.set("build-a111", { created: 1_700_000_000, paneCommand: "node", tail: "initial\n" });
    const controller = new AbortController();
    controller.abort();

    await bgTailFollow("build", { signal: controller.signal });

    expect(stdoutChunks).toEqual(["initial\n"]);
  });

  test("attach normalizes null process exit codes to a failure code", async () => {
    sessions.set("build-a111", { created: 1_700_000_000, paneCommand: "node", tail: "" });

    await expect(bgAttach("build")).resolves.toBe(-1);
  });
});
