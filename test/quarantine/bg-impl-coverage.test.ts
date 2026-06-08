/**
 * Isolated coverage for the vendored maw-bg implementation.
 *
 * The tmux process boundary is mocked so these tests exercise impl.ts control
 * flow without depending on a local tmux server or attaching to the terminal.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as realChild from "node:child_process";

const childProcessPath = "node:child_process";

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
  tail?: string;
};

const sessions = new Map<string, SessionFixture>();
const captureQueues = new Map<string, string[]>();
let spawnSyncCalls: Array<{ cmd: string; args: string[]; opts: unknown }> = [];
let spawnCalls: Array<{ cmd: string; args: string[]; opts: unknown }> = [];
let killedTargets: string[] = [];
let tmuxMissing = false;
let newSessionFailure: SpawnSyncResult | null = null;
let killFailure: SpawnSyncResult | null = null;
let captureFailure: SpawnSyncResult | null = null;
let listFailure: SpawnSyncResult | null = null;
let spawnSyncError: (Error & { code?: string }) | null = null;
let spawnError: (Error & { code?: string }) | null = null;
let spawnExitCode = 0;
let dropSessionOnNextHasSession = false;
let now = 1_700_000_000;

function stripPrefix(target: string): string {
  return target.replace(/^maw-bg-/, "");
}

function sessionListStdout(): string {
  return [...sessions.entries()]
    .map(([slug, fixture]) => `maw-bg-${slug}\t${fixture.created}\t${fixture.paneCommand}`)
    .join("\n");
}

function mockSpawnSync(cmd: string, args: string[] = [], opts: unknown = {}): SpawnSyncResult {
  spawnSyncCalls.push({ cmd, args, opts });
  if (tmuxMissing) {
    const error = new Error("tmux missing") as Error & { code: string };
    error.code = "ENOENT";
    return { error };
  }
  if (spawnSyncError) return { error: spawnSyncError };
  const [subcommand] = args;
  if (subcommand === "has-session") {
    const slug = stripPrefix(args.at(-1) ?? "");
    if (dropSessionOnNextHasSession) {
      dropSessionOnNextHasSession = false;
      sessions.delete(slug);
      return { status: 1, stdout: "", stderr: "" };
    }
    return { status: sessions.has(slug) ? 0 : 1, stdout: "", stderr: "" };
  }
  if (subcommand === "new-session") {
    if (newSessionFailure) return newSessionFailure;
    const sessionIndex = args.indexOf("-s");
    const sessionName = sessionIndex >= 0 ? args[sessionIndex + 1] : "maw-bg-unknown";
    const slug = stripPrefix(sessionName);
    sessions.set(slug, { created: now, paneCommand: "sh", lastLine: "", tail: "" });
    return { status: 0, stdout: "", stderr: "" };
  }
  if (subcommand === "list-sessions") {
    if (listFailure) return listFailure;
    return { status: 0, stdout: sessionListStdout(), stderr: "" };
  }
  if (subcommand === "capture-pane") {
    if (captureFailure) return captureFailure;
    const target = args[args.indexOf("-t") + 1] ?? "";
    const slug = stripPrefix(target);
    const fixture = sessions.get(slug);
    const queued = captureQueues.get(slug);
    const stdout = queued && queued.length > 0
      ? queued.shift()
      : fixture?.tail ?? fixture?.lastLine ?? "";
    return { status: fixture ? 0 : 1, stdout, stderr: fixture ? "" : "missing" };
  }
  if (subcommand === "kill-session") {
    if (killFailure) return killFailure;
    const target = args[args.indexOf("-t") + 1] ?? "";
    killedTargets.push(target);
    sessions.delete(stripPrefix(target));
    return { status: 0, stdout: "", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
}

function mockSpawn(cmd: string, args: string[] = [], opts: unknown = {}) {
  spawnCalls.push({ cmd, args, opts });
  const child = new EventEmitter();
  queueMicrotask(() => {
    if (spawnError) child.emit("error", spawnError);
    else child.emit("exit", spawnExitCode);
  });
  return child;
}

mock.module(childProcessPath, () => ({
  ...realChild,
  spawnSync: mockSpawnSync,
  spawn: mockSpawn,
}));

const realDateNow = Date.now;
const impl = await import("../../src/vendor/mpr-plugins/bg/src/impl.ts?bg-impl-coverage");
const {
  bgAttach,
  bgGc,
  bgKill,
  bgList,
  bgListSlugs,
  bgSpawn,
  bgTail,
  bgTailFollow,
  deriveSlug,
  holdsOpen,
  parseDuration,
  resolveSlug,
  validateName,
} = impl;

beforeEach(() => {
  sessions.clear();
  captureQueues.clear();
  spawnSyncCalls = [];
  spawnCalls = [];
  killedTargets = [];
  tmuxMissing = false;
  newSessionFailure = null;
  killFailure = null;
  captureFailure = null;
  listFailure = null;
  spawnSyncError = null;
  spawnError = null;
  spawnExitCode = 0;
  dropSessionOnNextHasSession = false;
  now = 1_700_000_000;
  Date.now = () => now * 1000;
  delete process.env.TMUX;
});

afterEach(() => {
  Date.now = realDateNow;
  delete process.env.TMUX;
});

describe("vendored bg impl coverage", () => {
  test("deriveSlug, validateName, resolveSlug, and duration parsing validate user inputs", () => {
    expect(deriveSlug("  pnpm---build --filter @scope/pkg  ")).toMatch(/^pnpm-build-[a-f0-9]{4}$/);
    expect(deriveSlug("***")).toMatch(/^cmd-[a-f0-9]{4}$/);
    expect(() => deriveSlug("   ")).toThrow(/command cannot be empty/);

    expect(() => validateName("ok-name-1")).not.toThrow();
    expect(() => validateName("Bad_Name")).toThrow(/invalid --name/);

    expect(resolveSlug("build-a111", ["build-a111"])).toBe("build-a111");
    expect(resolveSlug("a111", ["build-a111"])).toBe("build-a111");
    expect(resolveSlug("build", ["build-a111"])).toBe("build-a111");
    expect(() => resolveSlug("a111", ["build-a111", "test-a111"])).toThrow(/hash "a111" matches 2 sessions/);
    expect(() => resolveSlug("b", ["build-a111", "bench-b222"])).toThrow(/ref "b" matches 2 sessions/);
    expect(() => resolveSlug("none", ["build-a111"])).toThrow(/no session matching/);

    expect(parseDuration("30s")).toBe(30);
    expect(parseDuration("5m")).toBe(300);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("7d")).toBe(604800);
    expect(() => parseDuration("1w")).toThrow(/invalid --older-than/);
  });

  test("bgSpawn validates input, detects tmux errors, and starts held-open sessions safely", () => {
    expect(() => bgSpawn("   ")).toThrow(/command cannot be empty/);
    expect(() => bgSpawn("echo hi", { name: "Bad" })).toThrow(/invalid --name/);

    sessions.set("taken", { created: now, paneCommand: "sleep" });
    expect(() => bgSpawn("echo hi", { name: "taken" })).toThrow(/already running: taken/);

    tmuxMissing = true;
    expect(() => bgSpawn("echo hi", { name: "new-one" })).toThrow(/tmux not found/);
    tmuxMissing = false;

    newSessionFailure = { status: 7, stdout: "", stderr: "boom" };
    expect(() => bgSpawn("echo hi", { name: "new-one" })).toThrow(/new-session failed \(status 7\): boom/);
    newSessionFailure = null;

    const result = bgSpawn(" echo hi ", { name: "new-one" });
    expect(result).toEqual({ slug: "new-one", session: "maw-bg-new-one", cmd: "echo hi" });
    const newSessionCall = spawnSyncCalls.find((call) => call.args[0] === "new-session");
    expect(newSessionCall?.args).toEqual([
      "new-session", "-d",
      "-s", "maw-bg-new-one",
      "-n", "bg",
      "/bin/sh", "-c", holdsOpen("echo hi"),
    ]);

    const derived = bgSpawn("npm test");
    expect(derived.slug).toMatch(/^npm-[a-f0-9]{4}$/);
    expect(derived.session).toBe(`maw-bg-${derived.slug}`);
  });

  test("bgList parses maw-bg sessions, status, age, last line, and empty tmux states", () => {
    sessions.set("run-a111", { created: now - 10, paneCommand: "node", lastLine: "still running\n" });
    sessions.set("done-b222", { created: now - 40, paneCommand: "sleep", lastLine: "[done — exit 0]\n" });
    sessions.set("weird-c333", { created: "not-a-number", paneCommand: "", lastLine: "idle\n" });

    const listed = bgList();
    expect(listed).toEqual([
      { slug: "run-a111", session: "maw-bg-run-a111", ageSeconds: 10, status: "running", lastLine: "still running" },
      { slug: "done-b222", session: "maw-bg-done-b222", ageSeconds: 40, status: "done", lastLine: "[done — exit 0]" },
      { slug: "weird-c333", session: "maw-bg-weird-c333", ageSeconds: 0, status: "done", lastLine: "idle" },
    ]);
    expect(bgListSlugs()).toEqual(["run-a111", "done-b222", "weird-c333"]);

    listFailure = { status: 1, stdout: "", stderr: "no server running on /tmp/tmux" };
    expect(bgList()).toEqual([]);
    listFailure = { status: 2, stdout: "", stderr: "unexpected but empty" };
    expect(bgList()).toEqual([]);
  });

  test("bgList ignores non-maw sessions, handles capture failure, and rethrows non-ENOENT tmux errors", () => {
    sessions.set("visible-a111", { created: now - 12, paneCommand: "node", lastLine: "hidden" });
    listFailure = {
      status: 0,
      stdout: [
        "maw-bg-visible-a111\t1699999988\tnode",
        "plain-shell\t1699999999\tzsh",
      ].join("\n"),
      stderr: "",
    };
    captureFailure = { status: 9, stdout: "", stderr: "capture denied" };

    expect(bgList()).toEqual([{
      slug: "visible-a111",
      session: "maw-bg-visible-a111",
      ageSeconds: 12,
      status: "running",
      lastLine: "",
    }]);

    captureFailure = null;
    listFailure = null;
    const error = new Error("permission denied") as Error & { code: string };
    error.code = "EACCES";
    spawnSyncError = error;
    expect(() => bgList()).toThrow("permission denied");
  });

  test("bgTail resolves refs, captures requested lines, follows initial snapshot, and reports capture failures", async () => {
    sessions.set("build-a111", { created: now, paneCommand: "node", tail: "line 1\nline 2\n" });

    expect(bgTail("build", { lines: 5 })).toBe("line 1\nline 2");
    expect(spawnSyncCalls.at(-1)?.args).toContain("-5");

    captureFailure = { status: 4, stdout: "", stderr: "cannot capture" };
    expect(() => bgTail("build-a111")).toThrow(/capture-pane failed for build-a111: cannot capture/);
    captureFailure = null;

    const chunks: string[] = [];
    const controller = new AbortController();
    controller.abort();
    await bgTailFollow("a111", { writer: (chunk) => chunks.push(chunk), signal: controller.signal });
    expect(chunks).toEqual(["line 1\nline 2\n"]);
  });

  test("bgTailFollow reprints rolled buffers and reports ended sessions", async () => {
    sessions.set("roll-a111", { created: now, paneCommand: "node", tail: "first\n" });

    const rolledChunks: string[] = [];
    const rolledController = new AbortController();
    await bgTailFollow("roll", {
      writer: (chunk) => {
        rolledChunks.push(chunk);
        if (rolledChunks.length === 1) {
          sessions.set("roll-a111", { created: now, paneCommand: "node", tail: "rolled\n" });
        } else {
          rolledController.abort();
        }
      },
      signal: rolledController.signal,
    });
    expect(rolledChunks).toEqual(["first\n", "rolled\n"]);

    sessions.set("done-b222", { created: now, paneCommand: "node", tail: "initial\n" });
    const endedChunks: string[] = [];
    dropSessionOnNextHasSession = true;
    await bgTailFollow("done", { writer: (chunk) => endedChunks.push(chunk) });
    expect(endedChunks).toEqual(["initial\n", "[bg: session done-b222 ended]\n"]);
  });

  test("bgAttach chooses attach vs switch-client and maps spawn errors", async () => {
    sessions.set("build-a111", { created: now, paneCommand: "node" });

    await expect(bgAttach("build")).resolves.toBe(0);
    expect(spawnCalls.at(-1)?.args).toEqual(["attach-session", "-t", "maw-bg-build-a111"]);

    process.env.TMUX = "/tmp/tmux,1,0";
    spawnExitCode = 9;
    await expect(bgAttach("a111")).resolves.toBe(9);
    expect(spawnCalls.at(-1)?.args).toEqual(["switch-client", "-t", "maw-bg-build-a111"]);

    const error = new Error("missing tmux") as Error & { code: string };
    error.code = "ENOENT";
    spawnError = error;
    await expect(bgAttach("build-a111")).rejects.toThrow(/tmux not found/);

    const denied = new Error("spawn denied") as Error & { code: string };
    denied.code = "EACCES";
    spawnError = denied;
    await expect(bgAttach("build-a111")).rejects.toThrow("spawn denied");
  });

  test("bgKill handles missing args, single targets, all targets, and tmux kill failures", () => {
    sessions.set("one-a111", { created: now, paneCommand: "node" });
    sessions.set("two-b222", { created: now, paneCommand: "sleep" });

    expect(() => bgKill(undefined)).toThrow(/missing <slug>/);

    killFailure = { status: 5, stdout: "", stderr: "cannot kill" };
    expect(() => bgKill("one")).toThrow(/kill-session failed for one-a111: cannot kill/);
    killFailure = null;

    expect(bgKill("one")).toEqual(["one-a111"]);
    expect(killedTargets).toContain("maw-bg-one-a111");

    sessions.set("one-a111", { created: now, paneCommand: "node" });
    expect(bgKill(undefined, { all: true }).sort()).toEqual(["one-a111", "two-b222"]);
    expect(killedTargets).toEqual(expect.arrayContaining(["maw-bg-one-a111", "maw-bg-two-b222"]));
  });

  test("bgGc reaps only old done sessions and honors dry-run/default thresholds", () => {
    sessions.set("old-done", { created: now - 120, paneCommand: "sleep" });
    sessions.set("young-done", { created: now - 5, paneCommand: "read" });
    sessions.set("old-running", { created: now - 120, paneCommand: "node" });

    const dry = bgGc({ olderThan: "30s", dryRun: true });
    expect(dry).toEqual({
      reaped: ["old-done"],
      kept: ["young-done", "old-running"],
      dryRun: true,
      thresholdSeconds: 30,
    });
    expect(killedTargets).toEqual([]);

    const live = bgGc({ olderThan: "30s" });
    expect(live.reaped).toEqual(["old-done"]);
    expect(live.kept).toEqual(["young-done", "old-running"]);
    expect(killedTargets).toEqual(["maw-bg-old-done"]);

    const defaultThreshold = bgGc();
    expect(defaultThreshold.thresholdSeconds).toBe(24 * 60 * 60);
  });
});
