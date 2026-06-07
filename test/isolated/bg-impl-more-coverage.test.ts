import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as realChild from "node:child_process";

type SpawnSyncResult = {
  status?: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error & { code?: string };
};

type SessionFixture = {
  created: number | string;
  paneCommand: string;
  lastLine?: string;
};

const sessions = new Map<string, SessionFixture>();
const captureQueues = new Map<string, string[]>();
let hasSessionQueue: boolean[] = [];
let spawnError: (Error & { code?: string }) | null = null;
let spawnExitCode = 0;
let scheduledTimers: Array<() => void> = [];

const original = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};

function stripPrefix(target: string): string {
  return target.replace(/^maw-bg-/, "");
}

function sessionListStdout(): string {
  return [...sessions.entries()]
    .map(([slug, fixture]) => `maw-bg-${slug}\t${fixture.created}\t${fixture.paneCommand}`)
    .join("\n");
}

function mockSpawnSync(_cmd: string, args: string[] = []): SpawnSyncResult {
  const [subcommand] = args;
  if (subcommand === "list-sessions") {
    return { status: 0, stdout: sessionListStdout(), stderr: "" };
  }
  if (subcommand === "capture-pane") {
    const target = args[args.indexOf("-t") + 1] ?? "";
    const slug = stripPrefix(target);
    const fixture = sessions.get(slug);
    if (args.includes("-E")) {
      return { status: fixture ? 0 : 1, stdout: fixture?.lastLine ?? "", stderr: fixture ? "" : "missing" };
    }
    const queued = captureQueues.get(slug);
    const stdout = queued && queued.length > 0 ? queued.shift() : "";
    return { status: fixture ? 0 : 1, stdout, stderr: fixture ? "" : "missing" };
  }
  if (subcommand === "has-session") {
    const queued = hasSessionQueue.shift();
    if (queued !== undefined) return { status: queued ? 0 : 1, stdout: "", stderr: "" };
    const slug = stripPrefix(args.at(-1) ?? "");
    return { status: sessions.has(slug) ? 0 : 1, stdout: "", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
}

function mockSpawn(_cmd: string, _args: string[] = []) {
  const child = new EventEmitter();
  queueMicrotask(() => {
    if (spawnError) child.emit("error", spawnError);
    else child.emit("exit", spawnExitCode);
  });
  return child;
}

mock.module("node:child_process", () => ({
  ...realChild,
  spawnSync: mockSpawnSync,
  spawn: mockSpawn,
}));

const { bgAttach, bgTailFollow } = await import("../../src/vendor/mpr-plugins/bg/src/impl.ts?bg-impl-more-coverage");

beforeEach(() => {
  sessions.clear();
  captureQueues.clear();
  hasSessionQueue = [];
  spawnError = null;
  spawnExitCode = 0;
  scheduledTimers = [];
  installQueuedTimers();
  delete process.env.TMUX;
});

afterEach(() => {
  globalThis.setTimeout = original.setTimeout;
  globalThis.clearTimeout = original.clearTimeout;
  delete process.env.TMUX;
});

describe("vendored bg impl follow-loop coverage", () => {
  test("follow mode emits deltas, reprints changed tails, and reports ended sessions", async () => {
    sessions.set("build-a111", { created: 1_700_000_000, paneCommand: "node" });
    captureQueues.set("build-a111", ["one\n", "one\ntwo\n", "rolled\n"]);
    hasSessionQueue = [true, true, false];
    const chunks: string[] = [];

    const done = bgTailFollow("build", { writer: (chunk) => chunks.push(chunk) });
    expect(chunks).toEqual(["one\n"]);

    await flushNextTimer();
    expect(chunks).toEqual(["one\n", "\ntwo"]);

    await flushNextTimer();
    expect(chunks).toEqual(["one\n", "\ntwo", "rolled\n"]);

    await flushNextTimer();
    await done;
    expect(chunks).toEqual([
      "one\n",
      "\ntwo",
      "rolled\n",
      "[bg: session build-a111 ended]\n",
    ]);
  });

  test("follow sleep resolves promptly when aborted during the wait", async () => {
    sessions.set("abort-a111", { created: 1_700_000_000, paneCommand: "node" });
    captureQueues.set("abort-a111", ["start\n"]);
    const chunks: string[] = [];
    const controller = new AbortController();

    const done = bgTailFollow("abort", {
      writer: (chunk) => chunks.push(chunk),
      signal: controller.signal,
    });
    expect(chunks).toEqual(["start\n"]);
    expect(scheduledTimers).toHaveLength(1);

    controller.abort();
    await done;
    expect(chunks).toEqual(["start\n"]);
  });

  test("attach rejects non-ENOENT spawn errors without remapping them", async () => {
    sessions.set("build-a111", { created: 1_700_000_000, paneCommand: "node" });
    const error = new Error("permission denied") as Error & { code: string };
    error.code = "EACCES";
    spawnError = error;

    await expect(bgAttach("a111")).rejects.toThrow("permission denied");
  });
});

function installQueuedTimers(): void {
  globalThis.setTimeout = ((handler: unknown) => {
    scheduledTimers.push(() => {
      if (typeof handler === "function") (handler as () => void)();
    });
    return scheduledTimers.length as never;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
}

async function flushNextTimer(): Promise<void> {
  const timer = scheduledTimers.shift();
  expect(timer).toBeDefined();
  timer?.();
  await Promise.resolve();
}
