/** Targeted coverage for ui/impl-helpers.ts and capture/impl.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir as realHomedir, tmpdir } from "os";
import { join } from "path";

type Session = {
  name: string;
  windows?: Array<{ index: number; name?: string }>;
};

type ResolveResult =
  | { tier: 1; sessionName: string; ambiguousCandidates?: string[] }
  | { tier: 2; fleetName: string; ambiguousCandidates?: string[] }
  | null;

let namedPeers: Array<{ name: string; url: string }> = [];
let configValue: any;
let ghqPath: string | null = null;
let ghqCalls: string[] = [];
let mockHomeDir: string | null = null;

let sessions: Session[] = [];
let resolveResults: ResolveResult[] = [];
let resolveCalls: Array<{ target: string; sessions: Session[] }> = [];
let hostExecCalls: string[] = [];
let hostExecResult = "";
let hostExecError: unknown = null;
let tmuxBin = "tmux-test";

let logs: string[] = [];
let errors: string[] = [];
let tempDirs: string[] = [];

const originalHome = process.env.HOME;
const originalMawUiSrc = process.env.MAW_UI_SRC;
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
  listSessions: async () => sessions,
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

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/attach/resolve-attach-target.ts"), () => ({
  resolveAttachTarget: async (target: string, deps: any) => {
    const currentSessions = await deps.listSessions();
    resolveCalls.push({ target, sessions: currentSessions });
    return resolveResults.shift() ?? null;
  },
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

function restoreEnv(name: "HOME" | "MAW_UI_SRC", value: string | undefined) {
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
  resolveResults = [];
  resolveCalls = [];
  hostExecCalls = [];
  hostExecResult = "";
  hostExecError = null;
  tmuxBin = "tmux-test";

  logs = [];
  errors = [];
  tempDirs = [];
  restoreEnv("HOME", originalHome);
  restoreEnv("MAW_UI_SRC", originalMawUiSrc);
  console.log = (...args: any[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: any[]) => errors.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  restoreEnv("HOME", originalHome);
  restoreEnv("MAW_UI_SRC", originalMawUiSrc);
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
    expect(resolveCalls).toEqual([]);
    expect(hostExecCalls).toEqual([]);
  });

  test("reports ambiguous colon targets with all candidate names", async () => {
    sessions = [{ name: "mawjs" }, { name: "mawjs-alpha" }];
    resolveResults = [{ tier: 1, sessionName: "mawjs", ambiguousCandidates: ["mawjs", "mawjs-alpha"] }];

    await expect(cmdCapture("maw:2")).rejects.toThrow("'maw' is ambiguous — matches 2 sessions");

    expect(resolveCalls).toEqual([{ target: "maw", sessions }]);
    expect(errors.join("\n")).toContain("'maw' is ambiguous — matches 2 sessions");
    expect(errors.join("\n")).toContain("• mawjs");
    expect(errors.join("\n")).toContain("• mawjs-alpha");
    expect(hostExecCalls).toEqual([]);
  });

  test("reports missing colon targets with hints", async () => {
    sessions = [{ name: "clinic" }];
    resolveResults = [null];

    await expect(cmdCapture("clnic:1")).rejects.toThrow("session 'clnic' not found");

    expect(resolveCalls).toEqual([{ target: "clnic", sessions }]);
    expect(errors.join("\n")).toContain("try: maw ls");
    expect(hostExecCalls).toEqual([]);
  });

  test("reports missing colon targets without hints", async () => {
    sessions = [{ name: "neo" }];
    resolveResults = [null];

    await expect(cmdCapture("missing:4")).rejects.toThrow("session 'missing' not found");

    expect(resolveCalls).toEqual([{ target: "missing", sessions }]);
    expect(errors.join("\n")).not.toContain("did you mean:");
    expect(errors.join("\n")).toContain("try: maw ls");
    expect(hostExecCalls).toEqual([]);
  });

  test("reports ambiguous bare targets with all candidate names", async () => {
    sessions = [{ name: "neo" }, { name: "neo-alpha" }];
    resolveResults = [{ tier: 1, sessionName: "neo", ambiguousCandidates: ["neo", "neo-alpha"] }];

    await expect(cmdCapture("neo")).rejects.toThrow("'neo' is ambiguous — matches 2 sessions");

    expect(resolveCalls).toEqual([{ target: "neo", sessions }]);
    expect(errors.join("\n")).toContain("'neo' is ambiguous — matches 2 sessions");
    expect(errors.join("\n")).toContain("• neo");
    expect(errors.join("\n")).toContain("• neo-alpha");
    expect(hostExecCalls).toEqual([]);
  });

  test("reports missing bare targets with maw ls guidance when no hints exist", async () => {
    sessions = [{ name: "neo" }];
    resolveResults = [null];

    await expect(cmdCapture("missing")).rejects.toThrow("session 'missing' not found");

    expect(resolveCalls).toEqual([{ target: "missing", sessions }]);
    expect(errors.join("\n")).toContain("try: maw ls");
    expect(hostExecCalls).toEqual([]);
  });

  test("captures default bare target window with requested tail lines and prints raw output", async () => {
    sessions = [{ name: "Neo", windows: [{ index: 7, name: "shell" }] }];
    resolveResults = [{ tier: 1, sessionName: sessions[0]!.name }];
    hostExecResult = "hello\nworld";

    await cmdCapture("neo", { lines: 2 });

    expect(resolveCalls).toEqual([{ target: "neo", sessions }]);
    expect(hostExecCalls).toEqual(["tmux-test capture-pane -t 'Neo:7' -p -S -2"]);
    expect(logs).toEqual(["hello\nworld"]);
  });

  test("captures colon target with pane suffix and full scrollback", async () => {
    sessions = [{ name: "Neo", windows: [] }];
    resolveResults = [{ tier: 1, sessionName: sessions[0]!.name }];
    hostExecResult = "full history";

    await cmdCapture("neo:3", { pane: 2, full: true, lines: 1 });

    expect(resolveCalls).toEqual([{ target: "neo", sessions }]);
    expect(hostExecCalls).toEqual(["tmux-test capture-pane -t 'Neo:3.2' -p -S -"]);
    expect(logs).toEqual(["full history"]);
  });

  test("uses pane zero and default tail length when a match has an empty windows list", async () => {
    sessions = [{ name: "Sparse", windows: [] }];
    resolveResults = [{ tier: 1, sessionName: sessions[0]!.name }];
    hostExecResult = "";

    await cmdCapture("sparse");

    expect(resolveCalls).toEqual([{ target: "sparse", sessions }]);
    expect(hostExecCalls).toEqual(["tmux-test capture-pane -t 'Sparse:0' -p -S -50"]);
    expect(logs).toEqual([]);
  });

  test("wraps tmux capture failures with capture failed context", async () => {
    sessions = [{ name: "Neo", windows: [{ index: 0 }] }];
    resolveResults = [{ tier: 1, sessionName: sessions[0]!.name }];
    hostExecError = new Error("tmux missing");

    await expect(cmdCapture("neo")).rejects.toThrow("capture failed: tmux missing");

    expect(hostExecCalls).toEqual(["tmux-test capture-pane -t 'Neo:0' -p -S -50"]);
  });

  test("wraps non-Error tmux failures", async () => {
    sessions = [{ name: "Neo", windows: [{ index: 0 }] }];
    resolveResults = [{ tier: 1, sessionName: sessions[0]!.name }];
    hostExecError = "string boom";

    await expect(cmdCapture("neo")).rejects.toThrow("capture failed: string boom");

    expect(hostExecCalls).toEqual(["tmux-test capture-pane -t 'Neo:0' -p -S -50"]);
  });
  test("cmdCapture treats node-qualified targets as oracle aliases", async () => {
    resolveResults = [{ tier: 1, sessionName: "50-mawjs" }];
    sessions = [{ name: "50-mawjs", windows: [{ index: 0, name: "mawjs-oracle" }] }];

    await cmdCapture("m5:mawjs", { lines: 3 });

    expect(resolveCalls.at(-1)?.target).toBe("mawjs");
    expect(hostExecCalls.at(-1)).toContain("50-mawjs:0");
  });

  test("cmdCapture preserves numeric tmux window suffixes", async () => {
    resolveResults = [{ tier: 1, sessionName: "neo" }];
    sessions = [{ name: "neo", windows: [{ index: 0, name: "main" }] }];

    await cmdCapture("neo:2", { pane: 1, full: true });

    expect(resolveCalls.at(-1)?.target).toBe("neo");
    expect(hostExecCalls.at(-1)).toContain("neo:2.1");
  });

});
