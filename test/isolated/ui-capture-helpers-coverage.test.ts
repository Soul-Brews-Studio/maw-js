/** Targeted coverage for ui/impl-helpers.ts and capture/impl.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir as realHomedir, tmpdir } from "os";
import { join } from "path";

type Session = {
  name: string;
  windows?: Array<{ index: number; name?: string }>;
};

let namedPeers: Array<{ name: string; url: string }> = [];
let configValue: any;
let ghqPath: string | null = null;
let ghqCalls: string[] = [];
let mockHomeDir: string | null = null;

let sessions: Session[] = [];
let resolveTargetResults: Array<string | null> = [];
let resolveTargetCalls: string[] = [];
let hostExecCalls: string[] = [];
let hostExecResult = "";
let hostExecError: unknown = null;
let tmuxBin = "tmux-test";

let logs: string[] = [];
let errors: string[] = [];
let tempDirs: string[] = [];

const originalHome = process.env.HOME;
const originalMawUiSrc = process.env.MAW_UI_SRC;
const originalMawDataDir = process.env.MAW_DATA_DIR;
const originalLog = console.log;
const originalError = console.error;

mock.module("os", () => ({
  homedir: () => mockHomeDir ?? realHomedir(),
}));

mock.module("maw-js/config", () => ({
  loadConfig: () => (configValue === undefined ? { namedPeers } : configValue),
}));

mock.module("maw-js/core/ghq", () => ({
  ghqFindSync: (needle: string) => {
    ghqCalls.push(needle);
    return ghqPath;
  },
}));

mock.module("maw-js/sdk", () => ({
  loadConfig: () => (configValue === undefined ? { namedPeers } : configValue),
  listSessions: async () => sessions,
  loadFleetCore: () => [],
  resolvePeekTarget: async (target: string) => {
    resolveTargetCalls.push(target);
    return resolveTargetResults.shift() ?? null;
  },
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    if (hostExecError) throw hostExecError;
    return hostExecResult;
  },
  tmuxCmd: () => tmuxBin,
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleet: () => [],
}));

const {
  buildDevCommand,
  buildLensUrl,
  buildTunnelCommand,
  findMawUiSrcDir,
  isUiDistInstalled,
  justHost,
  resolvePeerHostPort,
} = await import("../../src/vendor/mpr-plugins/ui/impl-helpers.ts?ui-capture-helpers-coverage");

const { cmdCapture } = await import(
  "../../src/vendor/mpr-plugins/capture/impl.ts?ui-capture-helpers-coverage"
);

function makeTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(name: "HOME" | "MAW_UI_SRC" | "MAW_DATA_DIR", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  namedPeers = [
    { name: "clinic", url: "http://clinic.local:3456/" },
    { name: "secure", url: "https://secure.example" },
  ];
  configValue = undefined;
  mockHomeDir = null;
  ghqPath = null;
  ghqCalls = [];

  sessions = [];
  resolveTargetResults = [];
  resolveTargetCalls = [];
  hostExecCalls = [];
  hostExecResult = "";
  hostExecError = null;
  tmuxBin = "tmux-test";

  logs = [];
  errors = [];
  tempDirs = [];
  restoreEnv("HOME", originalHome);
  restoreEnv("MAW_UI_SRC", originalMawUiSrc);
  delete process.env.MAW_DATA_DIR;
  console.log = (...args: any[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: any[]) => errors.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  restoreEnv("HOME", originalHome);
  restoreEnv("MAW_UI_SRC", originalMawUiSrc);
  restoreEnv("MAW_DATA_DIR", originalMawDataDir);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("ui impl helpers coverage", () => {
  test("resolvePeerHostPort handles blank, named, literal, and invalid peers", () => {
    expect(resolvePeerHostPort("   ")).toBeNull();
    expect(resolvePeerHostPort("clinic")).toBe("clinic.local:3456");
    expect(resolvePeerHostPort("secure")).toBe("secure.example");
    expect(resolvePeerHostPort("localhost:1234")).toBe("localhost:1234");
    expect(resolvePeerHostPort("oracle-world.local")).toBe("oracle-world.local");
    expect(resolvePeerHostPort("bad/path")).toBeNull();
  });

  test("resolvePeerHostPort tolerates missing config peer lists", () => {
    configValue = null;
    expect(resolvePeerHostPort("clinic")).toBe("clinic");

    configValue = {};
    expect(resolvePeerHostPort("bad/path")).toBeNull();
  });

  test("host/url command helpers preserve documented defaults and encoding", () => {
    expect(justHost("clinic.local:3456")).toBe("clinic.local");
    expect(buildDevCommand("/tmp/maw-ui")).toBe("cd /tmp/maw-ui && bun run dev");
    expect(buildLensUrl({})).toBe("http://localhost:5173/federation_2d.html");
    expect(buildLensUrl({ threeD: true, port: 6000, remoteHost: "neo host:3456" })).toBe(
      "http://localhost:6000/federation.html?host=neo%20host%3A3456"
    );
    expect(buildTunnelCommand({ user: "nat", host: "clinic.local" })).toBe(
      "ssh -N -L 5173:localhost:5173 -L 3456:localhost:3456 nat@clinic.local"
    );
  });

  test("isUiDistInstalled follows the current home directory", () => {
    const home = makeTempDir("maw-ui-home-");
    mockHomeDir = home;

    expect(isUiDistInstalled()).toBe(false);

    const distDir = join(home, ".maw", "ui", "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<!doctype html>", "utf-8");

    expect(isUiDistInstalled()).toBe(true);
  });

  test("isUiDistInstalled follows MAW_DATA_DIR before the legacy home fallback", () => {
    const home = makeTempDir("maw-ui-legacy-home-");
    const dataDir = makeTempDir("maw-ui-data-");
    mockHomeDir = home;
    process.env.MAW_DATA_DIR = dataDir;

    const legacyDistDir = join(home, ".maw", "ui", "dist");
    mkdirSync(legacyDistDir, { recursive: true });
    writeFileSync(join(legacyDistDir, "index.html"), "<!doctype html>", "utf-8");

    expect(isUiDistInstalled()).toBe(false);

    const xdgDistDir = join(dataDir, "ui", "dist");
    mkdirSync(xdgDistDir, { recursive: true });
    writeFileSync(join(xdgDistDir, "index.html"), "<!doctype html>", "utf-8");

    expect(isUiDistInstalled()).toBe(true);
  });

  test("findMawUiSrcDir prefers ghq, then env override, otherwise null", () => {
    const ghqDir = makeTempDir("maw-ui-ghq-");
    mkdirSync(ghqDir, { recursive: true });
    writeFileSync(join(ghqDir, "package.json"), "{}", "utf-8");
    ghqPath = ghqDir;

    expect(findMawUiSrcDir()).toBe(ghqDir);
    expect(ghqCalls).toEqual(["/maw-ui"]);

    const missingGhqDir = makeTempDir("maw-ui-missing-ghq-");
    const envDir = makeTempDir("maw-ui-env-");
    writeFileSync(join(envDir, "package.json"), "{}", "utf-8");
    ghqPath = missingGhqDir;
    process.env.MAW_UI_SRC = envDir;
    ghqCalls = [];

    expect(findMawUiSrcDir()).toBe(envDir);
    expect(ghqCalls).toEqual(["/maw-ui"]);

    delete process.env.MAW_UI_SRC;
    ghqPath = null;

    expect(findMawUiSrcDir()).toBeNull();
  });
});

describe("capture impl coverage", () => {
  test("rejects a missing target before resolving sessions", async () => {
    await expect(cmdCapture("")).rejects.toThrow("usage: maw capture <target>");
    expect(resolveTargetCalls).toEqual([]);
    expect(hostExecCalls).toEqual([]);
  });

  test("reports missing targets using peek resolver guidance", async () => {
    resolveTargetResults = [null];

    await expect(cmdCapture("missing:4")).rejects.toThrow("target 'missing:4' not found");

    expect(resolveTargetCalls).toEqual(["missing:4"]);
    expect(errors.join("\n")).toContain("try: maw ls");
    expect(hostExecCalls).toEqual([]);
  });

  test("captures the exact target returned by the shared peek resolver", async () => {
    resolveTargetResults = ["Neo:7"];
    hostExecResult = "hello\nworld";

    await cmdCapture("neo", { lines: 2 });

    expect(resolveTargetCalls).toEqual(["neo"]);
    expect(hostExecCalls).toEqual(["tmux-test capture-pane -t 'Neo:7' -p -S -2"]);
    expect(logs).toEqual(["hello\nworld"]);
  });

  test("regression #2804: session:window targets resolved by peek also capture", async () => {
    resolveTargetResults = ["167-web-v2:2"];
    hostExecResult = "web-v2 pane";

    await cmdCapture("web-v2:2", { lines: 5 });

    expect(resolveTargetCalls).toEqual(["web-v2:2"]);
    expect(hostExecCalls).toEqual(["tmux-test capture-pane -t '167-web-v2:2' -p -S -5"]);
    expect(logs).toEqual(["web-v2 pane"]);
  });

  test("preserves explicit --pane and full scrollback on the resolved target", async () => {
    resolveTargetResults = ["Neo:3"];
    hostExecResult = "full history";

    await cmdCapture("neo:3", { pane: 2, full: true, lines: 1 });

    expect(resolveTargetCalls).toEqual(["neo:3"]);
    expect(hostExecCalls).toEqual(["tmux-test capture-pane -t 'Neo:3.2' -p -S -"]);
    expect(logs).toEqual(["full history"]);
  });

  test("wraps tmux capture failures with capture failed context", async () => {
    resolveTargetResults = ["Neo:0"];
    hostExecError = new Error("tmux missing");

    await expect(cmdCapture("neo")).rejects.toThrow("capture failed: tmux missing");

    expect(hostExecCalls).toEqual(["tmux-test capture-pane -t 'Neo:0' -p -S -50"]);
  });

  test("wraps non-Error tmux failures", async () => {
    resolveTargetResults = ["Neo:0"];
    hostExecError = "string boom";

    await expect(cmdCapture("neo")).rejects.toThrow("capture failed: string boom");

    expect(hostExecCalls).toEqual(["tmux-test capture-pane -t 'Neo:0' -p -S -50"]);
  });
});
