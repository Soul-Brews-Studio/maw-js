/**
 * Isolated coverage for src/vendor/mpr-plugins/park/src/impl.ts.
 *
 * The implementation captures tmux + git state and writes snapshots under the
 * user's home directory, so this test mocks the process seams and redirects all
 * filesystem writes to per-test temp homes.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as realChild from "node:child_process";

const childProcessPath = "node:child_process";
const osPath = "node:os";

type SpawnSyncResult = {
  status?: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error & { code?: string };
};

type WindowFixture = {
  name: string;
  cwd: string;
};

const homeDir = mkdtempSync(join(tmpdir(), "maw-park-home-"));
const legacyParkedDir = join(homeDir, ".config/maw/parked");
process.env.MAW_STATE_DIR = join(homeDir, ".maw-state");
process.env.MAW_CONFIG_DIR = join(homeDir, ".config/maw");
let sessionName = "oracle";
let currentWindow = "coding";
let windows: WindowFixture[] = [];
let gitByCwd = new Map<string, { branch: string; lastCommit: string; dirty: string }>();
let tmuxFailures = new Map<string, SpawnSyncResult>();
let spawnSyncCalls: Array<{ cmd: string; args: string[]; opts: unknown }> = [];
let logs: string[] = [];

const original = {
  log: console.log,
};

function windowListStdout(): string {
  return windows.map((window, index) => `${index}:${window.name}`).join("\n");
}

function targetWindowFromArgs(args: string[]): string {
  const targetIndex = args.indexOf("-t");
  const target = targetIndex >= 0 ? args[targetIndex + 1] : `${sessionName}:${currentWindow}`;
  return target.includes(":") ? target.slice(target.indexOf(":") + 1) : target;
}

function mockSpawnSync(cmd: string, args: string[] = [], opts: unknown = {}): SpawnSyncResult {
  spawnSyncCalls.push({ cmd, args, opts });

  if (cmd === "tmux") {
    const subcommand = args[0] ?? "";
    const failure = tmuxFailures.get(subcommand);
    if (failure) return failure;

    if (subcommand === "display-message" && args.includes("#S")) {
      return { status: 0, stdout: `${sessionName}\n`, stderr: "" };
    }
    if (subcommand === "display-message" && args.includes("#W")) {
      return { status: 0, stdout: `${currentWindow}\n`, stderr: "" };
    }
    if (subcommand === "display-message" && args.includes("#{pane_current_path}")) {
      const targetWindow = targetWindowFromArgs(args);
      const fixture = windows.find((window) => window.name === targetWindow);
      return fixture
        ? { status: 0, stdout: `${fixture.cwd}\n`, stderr: "" }
        : { status: 1, stdout: "", stderr: `missing window ${targetWindow}` };
    }
    if (subcommand === "list-windows") {
      return { status: 0, stdout: windowListStdout(), stderr: "" };
    }
  }

  if (cmd === "git") {
    const cwd = (opts as { cwd?: string }).cwd ?? "";
    const git = gitByCwd.get(cwd);
    if (!git) return { status: 1, stdout: "", stderr: "" };

    if (args.join(" ") === "branch --show-current") {
      return { status: 0, stdout: `${git.branch}\n`, stderr: "" };
    }
    if (args.join(" ") === "log -1 --oneline") {
      return { status: 0, stdout: `${git.lastCommit}\n`, stderr: "" };
    }
    if (args.join(" ") === "status --short") {
      return { status: 0, stdout: git.dirty, stderr: "" };
    }
  }

  return { status: 0, stdout: "", stderr: "" };
}

mock.module(childProcessPath, () => ({
  ...realChild,
  spawnSync: mockSpawnSync,
}));

mock.module(osPath, () => ({
  homedir: () => homeDir,
}));

const impl = await import("../../src/vendor/mpr-plugins/park/src/impl.ts?park-impl-coverage");
const { PARKED_DIR, cmdPark, cmdParkLs, resolvePark, timeAgo } = impl;

beforeEach(() => {
  rmSync(PARKED_DIR, { recursive: true, force: true });
  rmSync(legacyParkedDir, { recursive: true, force: true });
  sessionName = "oracle";
  currentWindow = "coding";
  windows = [
    { name: "coding", cwd: mkdtempSync(join(tmpdir(), "maw-park-coding-")) },
    { name: "review", cwd: mkdtempSync(join(tmpdir(), "maw-park-review-")) },
  ];
  gitByCwd = new Map([
    [windows[0].cwd, { branch: "alpha", lastCommit: "abc1234 current work", dirty: " M src/current.ts\n?? scratch.md\n" }],
    [windows[1].cwd, { branch: "feature/review", lastCommit: "def5678 review work", dirty: "" }],
  ]);
  tmuxFailures = new Map();
  spawnSyncCalls = [];
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = original.log;
  for (const window of windows) {
    rmSync(window.cwd, { recursive: true, force: true });
  }
});

process.on("exit", () => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe("vendored park impl coverage", () => {
  test("pure helpers resolve target windows and format coarse relative time", () => {
    expect(resolvePark([], "coding", ["coding", "review"])).toEqual({ target: "coding", note: undefined });
    expect(resolvePark(["review"], "coding", ["coding", "review"])).toEqual({ target: "review", note: undefined });
    expect(resolvePark(["review", "handoff", "ready"], "coding", ["coding", "review"])).toEqual({
      target: "review",
      note: "handoff ready",
    });
    expect(resolvePark(["coding"], "coding", ["coding", "review"])).toEqual({ target: "coding", note: "coding" });
    expect(resolvePark(["note", "for", "current"], "coding", ["coding", "review"])).toEqual({
      target: "coding",
      note: "note for current",
    });

    const now = Date.parse("2026-05-18T03:00:00.000Z");
    expect(timeAgo("2026-05-18T02:45:00.000Z", now)).toBe("15m ago");
    expect(timeAgo("2026-05-18T01:00:00.000Z", now)).toBe("2h ago");
    expect(timeAgo("2026-05-16T00:00:00.000Z", now)).toBe("2d ago");
  });

  test("cmdPark snapshots current window git state into the mocked parked directory", async () => {
    await cmdPark("deep", "focus");

    const snapshotPath = join(PARKED_DIR, "coding.json");
    expect(snapshotPath.startsWith(homeDir)).toBe(true);
    expect(existsSync(snapshotPath)).toBe(true);

    const state = JSON.parse(readFileSync(snapshotPath, "utf-8"));
    expect(state).toMatchObject({
      window: "coding",
      session: "oracle",
      branch: "alpha",
      cwd: windows[0].cwd,
      lastCommit: "abc1234 current work",
      dirtyFiles: ["M src/current.ts", "?? scratch.md"],
      note: "deep focus",
    });
    expect(new Date(state.parkedAt).toString()).not.toBe("Invalid Date");
    expect(logs.join("\n")).toContain("parked");
    expect(logs.join("\n")).toContain("coding");
    expect(logs.join("\n")).toContain("deep focus");

    expect(spawnSyncCalls.filter((call) => call.cmd === "tmux").map((call) => call.args[0])).toEqual([
      "display-message",
      "display-message",
      "list-windows",
      "display-message",
    ]);
    expect(spawnSyncCalls.filter((call) => call.cmd === "git").map((call) => call.args.join(" "))).toEqual([
      "branch --show-current",
      "log -1 --oneline",
      "status --short",
    ]);
  });

  test("cmdPark targets a known non-current window and tolerates non-git panes", async () => {
    gitByCwd.delete(windows[1].cwd);

    await cmdPark("review", "resume", "later");

    const state = JSON.parse(readFileSync(join(PARKED_DIR, "review.json"), "utf-8"));
    expect(state).toMatchObject({
      window: "review",
      session: "oracle",
      cwd: windows[1].cwd,
      branch: "",
      lastCommit: "",
      dirtyFiles: [],
      note: "resume later",
    });
    expect(logs.join("\n")).toContain("review");
  });

  test("cmdParkLs reports empty, clean, dirty, noted, and unnoted snapshots", async () => {
    await cmdParkLs();
    expect(logs.join("\n")).toContain("no parked tabs");

    logs = [];
    const now = new Date(Date.now() - 90 * 60000).toISOString();
    writeFileSync(
      join(PARKED_DIR, "coding.json"),
      JSON.stringify({
        window: "coding",
        session: "oracle",
        branch: "alpha",
        cwd: windows[0].cwd,
        lastCommit: "abc1234 current work",
        dirtyFiles: ["M src/current.ts"],
        note: "return here",
        parkedAt: now,
      }),
    );
    writeFileSync(
      join(PARKED_DIR, "review.json"),
      JSON.stringify({
        window: "review",
        session: "oracle",
        branch: "feature/review",
        cwd: windows[1].cwd,
        lastCommit: "def5678 review work",
        dirtyFiles: [],
        note: "",
        parkedAt: now,
      }),
    );
    writeFileSync(join(PARKED_DIR, "ignore.txt"), "not a snapshot");

    await cmdParkLs();

    const output = logs.join("\n");
    expect(output).toContain("PARKED");
    expect(output).toContain("(2)");
    expect(output).toContain("coding");
    expect(output).toContain('"return here"');
    expect(output).toContain("alpha");
    expect(output).toContain("1 dirty");
    expect(output).toContain("review");
    expect(output).toContain("(no note)");
    expect(output).toContain("feature/review");
    expect(output).toContain("clean");
    expect(output).not.toContain("ignore.txt");
  });

  test("cmdParkLs includes legacy config parked snapshots while new writes use state", async () => {
    await cmdPark("state", "snapshot");
    expect(existsSync(join(PARKED_DIR, "coding.json"))).toBe(true);
    expect(existsSync(join(legacyParkedDir, "coding.json"))).toBe(false);

    mkdirSync(legacyParkedDir, { recursive: true });
    writeFileSync(
      join(legacyParkedDir, "legacy.json"),
      JSON.stringify({
        window: "legacy",
        session: "oracle",
        branch: "old",
        cwd: windows[0].cwd,
        lastCommit: "0000000 legacy work",
        dirtyFiles: [],
        note: "legacy parked tab",
        parkedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );

    logs = [];
    await cmdParkLs();

    const output = logs.join("\n");
    expect(output).toContain("coding");
    expect(output).toContain("legacy");
    expect(output).toContain("legacy parked tab");
  });

  test("tmux failures surface stderr and prevent snapshot writes", async () => {
    tmuxFailures.set("list-windows", { status: 7, stdout: "", stderr: "tmux exploded" });

    await expect(cmdPark()).rejects.toThrow("tmux exploded");
    expect(existsSync(join(PARKED_DIR, "coding.json"))).toBe(false);
  });
});
