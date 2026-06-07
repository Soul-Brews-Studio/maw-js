import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const MOCK_FLEET_DIR = "/mock/maw/fleet";
const MOCK_GHQ_ROOT = "/mock/ghq";

type FleetEntry = {
  file: string;
  path?: string;
  session: {
    name: string;
    windows: Array<{ name: string; repo?: string }>;
  };
};

let fleetEntries: FleetEntry[] = [];
let runningSessions: string[] = [];
let tmuxRunBySession = new Map<string, string | Error>();

let repoFleetExists = true;
let repoFleetFiles: string[] = [];
let existsCalls: string[] = [];
let mkdirCalls: Array<{ path: string; opts: unknown }> = [];
let unlinkCalls: string[] = [];
let unlinkThrowsFor = new Set<string>();
let symlinkCalls: Array<{ src: string; dest: string }> = [];
let writeFleetDir = MOCK_FLEET_DIR;

const loadFleetEntriesMock = mock(() => fleetEntries);
const getSessionNamesMock = mock(async () => runningSessions);
const fleetDirForWriteMock = mock(() => writeFleetDir);
const getGhqRootMock = mock(() => MOCK_GHQ_ROOT);
const tmuxRunMock = mock(async (...args: string[]) => {
  const sessionName = args[2];
  const result = tmuxRunBySession.get(sessionName);
  if (result instanceof Error) throw result;
  return result ?? "";
});

const existsSyncMock = mock((path: string) => {
  existsCalls.push(String(path));
  return repoFleetExists;
});
const readdirSyncMock = mock((_path: string) => [...repoFleetFiles]);
const mkdirSyncMock = mock((path: string, opts?: unknown) => {
  mkdirCalls.push({ path: String(path), opts });
});
const unlinkSyncMock = mock((path: string) => {
  const dest = String(path);
  unlinkCalls.push(dest);
  if (unlinkThrowsFor.has(dest)) throw new Error(`missing ${dest}`);
});
const symlinkSyncMock = mock((src: string, dest: string) => {
  symlinkCalls.push({ src: String(src), dest: String(dest) });
});

mock.module("fs", () => ({
  existsSync: existsSyncMock,
  readdirSync: readdirSyncMock,
  mkdirSync: mkdirSyncMock,
  unlinkSync: unlinkSyncMock,
  symlinkSync: symlinkSyncMock,
}));

mock.module(import.meta.resolve("../../src/sdk"), () => ({
  FLEET_DIR: MOCK_FLEET_DIR,
  tmux: { run: tmuxRunMock },
}));

mock.module(import.meta.resolve("../../src/config/ghq-root"), () => ({
  getGhqRoot: getGhqRootMock,
}));

mock.module(import.meta.resolve("../../src/commands/shared/fleet-load"), () => ({
  loadFleetEntries: loadFleetEntriesMock,
  getSessionNames: getSessionNamesMock,
  fleetDirForWrite: fleetDirForWriteMock,
}));

const { cmdFleetSync, cmdFleetSyncConfigs } = await import(
  "../../src/commands/shared/fleet-sync.ts?fleet-sync-extra-coverage"
);

let logs: string[] = [];
let errors: string[] = [];
let writeCalls: Array<{ path: string; data: string }> = [];
let writeSpy: ReturnType<typeof spyOn> | null = null;
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalExit: typeof process.exit;
let exitCalls: Array<string | number | null | undefined> = [];

beforeEach(() => {
  fleetEntries = [];
  runningSessions = [];
  tmuxRunBySession = new Map();

  repoFleetExists = true;
  repoFleetFiles = [];
  existsCalls = [];
  mkdirCalls = [];
  unlinkCalls = [];
  unlinkThrowsFor = new Set();
  symlinkCalls = [];
  writeFleetDir = MOCK_FLEET_DIR;

  logs = [];
  errors = [];
  writeCalls = [];
  exitCalls = [];

  loadFleetEntriesMock.mockClear();
  getSessionNamesMock.mockClear();
  fleetDirForWriteMock.mockClear();
  getGhqRootMock.mockClear();
  tmuxRunMock.mockClear();
  existsSyncMock.mockClear();
  readdirSyncMock.mockClear();
  mkdirSyncMock.mockClear();
  unlinkSyncMock.mockClear();
  symlinkSyncMock.mockClear();

  originalLog = console.log;
  originalError = console.error;
  originalExit = process.exit;
  console.log = (...parts: unknown[]) => {
    logs.push(parts.map(String).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    errors.push(parts.map(String).join(" "));
  };
  process.exit = ((code?: string | number | null | undefined) => {
    exitCalls.push(code);
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;

  writeSpy = spyOn(Bun, "write").mockImplementation(((path: unknown, data: unknown) => {
    writeCalls.push({ path: String(path), data: String(data) });
    return Promise.resolve(String(data).length);
  }) as typeof Bun.write);
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
  writeSpy?.mockRestore();
  writeSpy = null;
});

describe("fleet sync extra coverage", () => {
  test("adds unregistered running windows, derives ghq repos, skips registered and stopped sessions, and writes updated config", async () => {
    const alphaSession = {
      name: "alpha-session",
      windows: [{ name: "main", repo: "Soul-Brews-Studio/maw-js" }],
    };
    const stoppedSession = {
      name: "stopped-session",
      windows: [{ name: "offline", repo: "Soul-Brews-Studio/offline" }],
    };
    fleetEntries = [
      { file: "alpha.json", session: alphaSession },
      { file: "stopped.json", session: stoppedSession },
    ];
    runningSessions = ["alpha-session"];
    tmuxRunBySession.set(
      "alpha-session",
      [
        "main:/mock/ghq/github.com/Soul-Brews-Studio/maw-js",
        "newrepo:/mock/ghq/github.com/Soul-Brews-Studio/new-repo",
        "scratch:/tmp/scratch-space",
        ":/mock/ghq/github.com/Soul-Brews-Studio/blank-name",
        "",
      ].join("\n"),
    );

    await cmdFleetSync();

    expect(loadFleetEntriesMock).toHaveBeenCalledTimes(1);
    expect(getSessionNamesMock).toHaveBeenCalledTimes(1);
    expect(getGhqRootMock).toHaveBeenCalledTimes(1);
    expect(tmuxRunMock).toHaveBeenCalledTimes(1);
    expect(tmuxRunMock.mock.calls[0]).toEqual([
      "list-windows",
      "-t",
      "alpha-session",
      "-F",
      "#{window_name}:#{pane_current_path}",
    ]);

    expect(alphaSession.windows).toEqual([
      { name: "main", repo: "Soul-Brews-Studio/maw-js" },
      { name: "newrepo", repo: "Soul-Brews-Studio/new-repo" },
      { name: "scratch", repo: "" },
    ]);
    expect(stoppedSession.windows).toEqual([{ name: "offline", repo: "Soul-Brews-Studio/offline" }]);
    expect(writeCalls).toEqual([
      {
        path: `${MOCK_FLEET_DIR}/alpha.json`,
        data: `${JSON.stringify(alphaSession, null, 2)}\n`,
      },
    ]);

    const output = logs.join("\n");
    expect(output).toContain("+\u001b[0m newrepo → alpha.json (Soul-Brews-Studio/new-repo)");
    expect(output).toContain("+\u001b[0m scratch → alpha.json");
    expect(output).toContain("2 window(s) added to fleet configs");
    expect(errors).toEqual([]);
  });

  test("writes synced windows back to the XDG state fleet file supplied by the shared loader", async () => {
    const alphaSession = {
      name: "alpha-session",
      windows: [{ name: "main", repo: "Soul-Brews-Studio/maw-js" }],
    };
    fleetEntries = [
      { file: "alpha.json", path: "/mock/state/maw/fleet/alpha.json", session: alphaSession },
    ];
    writeFleetDir = "/mock/legacy/config/fleet";
    runningSessions = ["alpha-session"];
    tmuxRunBySession.set(
      "alpha-session",
      "main:/mock/ghq/github.com/Soul-Brews-Studio/maw-js\ncodex:/mock/ghq/github.com/Soul-Brews-Studio/maw-js.wt-codex",
    );

    await cmdFleetSync();

    expect(writeCalls).toEqual([
      {
        path: "/mock/state/maw/fleet/alpha.json",
        data: `${JSON.stringify(alphaSession, null, 2)}\n`,
      },
    ]);
    expect(fleetDirForWriteMock).not.toHaveBeenCalled();
  });

  test("prints all-clear and avoids writes when running windows are already registered", async () => {
    fleetEntries = [
      {
        file: "alpha.json",
        session: {
          name: "alpha-session",
          windows: [{ name: "main", repo: "Soul-Brews-Studio/maw-js" }],
        },
      },
      {
        file: "stopped.json",
        session: {
          name: "stopped-session",
          windows: [{ name: "offline", repo: "Soul-Brews-Studio/offline" }],
        },
      },
    ];
    runningSessions = ["alpha-session"];
    tmuxRunBySession.set("alpha-session", "\nmain:/mock/ghq/github.com/Soul-Brews-Studio/maw-js\n");

    await cmdFleetSync();

    expect(tmuxRunMock).toHaveBeenCalledTimes(1);
    expect(writeCalls).toEqual([]);
    expect(logs.join("\n")).toContain("✓ Fleet in sync");
    expect(errors).toEqual([]);
  });

  test("logs tmux sync failures and still completes without writing when nothing was added", async () => {
    fleetEntries = [
      {
        file: "broken.json",
        session: {
          name: "broken-session",
          windows: [{ name: "main", repo: "Soul-Brews-Studio/maw-js" }],
        },
      },
    ];
    runningSessions = ["broken-session"];
    tmuxRunBySession.set("broken-session", new Error("tmux unavailable"));

    await cmdFleetSync();

    expect(writeCalls).toEqual([]);
    expect(errors.join("\n")).toContain("failed to sync broken-session: Error: tmux unavailable");
    expect(logs.join("\n")).toContain("✓ Fleet in sync");
  });

  test("sync configs exits with an error when the repo fleet directory is missing", async () => {
    repoFleetExists = false;

    await expect(cmdFleetSyncConfigs()).rejects.toThrow("process.exit:1");

    expect(exitCalls).toEqual([1]);
    expect(errors.join("\n")).toContain("No fleet/ directory found in repo");
    expect(readdirSyncMock).not.toHaveBeenCalled();
    expect(mkdirSyncMock).not.toHaveBeenCalled();
  });

  test("sync configs returns early when the repo fleet directory contains no json configs", async () => {
    repoFleetExists = true;
    repoFleetFiles = ["README.md", "alpha.json.disabled", "notes.txt"];

    await cmdFleetSyncConfigs();

    expect(existsSyncMock).toHaveBeenCalledTimes(1);
    expect(readdirSyncMock).toHaveBeenCalledTimes(1);
    expect(mkdirSyncMock).not.toHaveBeenCalled();
    expect(unlinkSyncMock).not.toHaveBeenCalled();
    expect(symlinkSyncMock).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("No fleet configs to sync");
  });

  test("sync configs symlinks json configs, ignores unlink misses, and reports synced count", async () => {
    repoFleetExists = true;
    repoFleetFiles = ["alpha.json", "README.md", "beta.json"];
    writeFleetDir = "/mock/state/maw/fleet";
    unlinkThrowsFor = new Set([`${writeFleetDir}/alpha.json`]);

    await cmdFleetSyncConfigs();

    expect(fleetDirForWriteMock).toHaveBeenCalledTimes(1);
    expect(mkdirCalls).toEqual([{ path: writeFleetDir, opts: { recursive: true } }]);
    expect(unlinkCalls).toEqual([`${writeFleetDir}/alpha.json`, `${writeFleetDir}/beta.json`]);
    expect(symlinkCalls).toHaveLength(2);
    expect(symlinkCalls[0]).toEqual({
      src: expect.stringContaining("/src/fleet/alpha.json"),
      dest: `${writeFleetDir}/alpha.json`,
    });
    expect(symlinkCalls[1]).toEqual({
      src: expect.stringContaining("/src/fleet/beta.json"),
      dest: `${writeFleetDir}/beta.json`,
    });
    expect(logs.join("\n")).toContain(`✓ 2 fleet config(s) synced\u001b[0m → ${writeFleetDir}`);
  });
});
