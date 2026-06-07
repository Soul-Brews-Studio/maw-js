/**
 * Fourteenth-pass isolated branch coverage for wake-resolve-impl.
 *
 * Fully mocked: exercises local resolver fallback branches without touching
 * live ghq, tmux, GitHub, fleet state, pass, or federation peers.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");
const fleetRoot = mkdtempSync(join(tmpdir(), "maw-wake-resolve-14-fleet-"));
const parentRoot = mkdtempSync(join(tmpdir(), "maw-wake-resolve-14-parent-"));

type OracleResult =
  | { kind: "not-found" }
  | { kind: "exact"; oracle: { owner: string; repo: string; path?: string } }
  | { kind: "ambiguous"; candidates: Array<{ owner: string; repo: string; path?: string }> };

let config: any;
let sessions: Array<{ name: string }>;
let ghqListValue: string[];
let ghqFindValue: string | null;
let resolveResults: OracleResult[];
let pickedOracle: { owner: string; repo: string; path?: string } | null;
let hostExecCalls: string[];
let hostExecHandler: (cmd: string) => Promise<string>;
let scanSuggestResult: any;
let scanSuggestArgs: any[];
let isattyThrows: boolean;
let isattyValue: boolean;
let exitCodes: number[];
let logs: string[];
let errors: string[];

const originalExit = process.exit;
const originalLog = console.log;
const originalError = console.error;
const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;

function resetFleetDir(): void {
  rmSync(fleetRoot, { recursive: true, force: true });
  mkdirSync(fleetRoot, { recursive: true });
}

function writeFleet(name: string, body: unknown): void {
  writeFileSync(join(fleetRoot, `${name}.json`), typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

mock.module("node:tty", () => ({
  isatty: () => {
    if (isattyThrows) throw new Error("tty probe unavailable");
    return isattyValue;
  },
}));

mock.module(join(srcRoot, "src/sdk"), () => ({
  FLEET_DIR: fleetRoot,
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return hostExecHandler(cmd);
  },
  curlFetch: async () => ({ ok: false }),
  tmux: {
    listSessions: async () => sessions,
    setEnvironment: async () => undefined,
  },
}));

mock.module(join(srcRoot, "src/config"), () => ({
  loadConfig: () => config,
  getEnvVars: () => ({}),
}));

mock.module(join(srcRoot, "src/core/ghq"), () => ({
  ghqList: async () => ghqListValue,
  ghqFind: async () => ghqFindValue,
}));

mock.module(join(srcRoot, "src/core/resolve"), () => ({
  resolveOracle: async () => resolveResults.shift() ?? { kind: "not-found" },
  pickOracle: async () => pickedOracle,
}));

mock.module(join(srcRoot, "src/core/fleet/worktrees-scan"), () => ({
  scanWorktrees: async () => [],
}));

mock.module(join(srcRoot, "src/commands/shared/wake-resolve-scan-suggest"), () => ({
  scanSuggestOracle: async (...args: any[]) => {
    scanSuggestArgs.push(args);
    return scanSuggestResult;
  },
}));

const {
  detectSession,
  findReusableWorktreeBySlug,
  findWorktrees,
  resolveFleetSession,
  resolveOracle,
} = await import("../../src/commands/shared/wake-resolve-impl");

beforeEach(() => {
  resetFleetDir();
  config = { githubOrg: "FallbackOrg", peers: [], sessions: {} };
  sessions = [];
  ghqListValue = [];
  ghqFindValue = null;
  resolveResults = [{ kind: "not-found" }];
  pickedOracle = null;
  hostExecCalls = [];
  hostExecHandler = async () => "";
  scanSuggestResult = null;
  scanSuggestArgs = [];
  isattyThrows = false;
  isattyValue = false;
  exitCodes = [];
  logs = [];
  errors = [];

  console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); };
  console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(" ")); };
  process.exit = ((code?: number) => {
    exitCodes.push(code ?? 0);
    return undefined as never;
  }) as typeof process.exit;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
});

afterEach(() => {
  process.exit = originalExit;
  console.log = originalLog;
  console.error = originalError;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalStdinIsTTY });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalStdoutIsTTY });
});

afterAll(() => {
  rmSync(fleetRoot, { recursive: true, force: true });
  rmSync(parentRoot, { recursive: true, force: true });
});

describe("resolveOracle local picker and fallback branches", () => {
  test("returns exact local oracle refs before remote fallbacks", async () => {
    ghqListValue = ["github.com/Alt/neo-oracle"];
    resolveResults = [{
      kind: "exact",
      oracle: { owner: "Alt", repo: "neo-oracle", path: "/repos/Alt/neo-oracle" },
    }];

    await expect(resolveOracle("neo")).resolves.toEqual({
      repoPath: "/repos/Alt/neo-oracle",
      repoName: "neo-oracle",
      parentDir: "/repos/Alt",
    });
    expect(exitCodes).toEqual([]);
    expect(hostExecCalls).toEqual([]);
  });

  test("falls through when exact local refs lack a repo path", async () => {
    ghqListValue = ["github.com/Org/pathless-oracle"];
    resolveResults = [{ kind: "exact", oracle: { owner: "Org", repo: "pathless-oracle" } }];
    scanSuggestResult = { repoPath: "/suggested/pathless-oracle", repoName: "pathless-oracle", parentDir: "/suggested" };

    await expect(resolveOracle("pathless", { allLocal: true })).resolves.toEqual(scanSuggestResult);
    expect(exitCodes).toEqual([]);
    expect(scanSuggestArgs[0]).toEqual(["pathless", { allLocal: true }]);
  });

  test("interactive ambiguity picker returns the selected local oracle path", async () => {
    ghqListValue = ["github.com/Org/pulse-oracle", "github.com/Alt/pulse-oracle"];
    resolveResults = [{
      kind: "ambiguous",
      candidates: [
        { owner: "Org", repo: "pulse-oracle", path: "/repos/Org/pulse-oracle" },
        { owner: "Alt", repo: "pulse-oracle", path: "/repos/Alt/pulse-oracle" },
      ],
    }];
    isattyValue = true;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    pickedOracle = { owner: "Alt", repo: "pulse-oracle", path: "/repos/Alt/pulse-oracle" };

    const ttyModule = require("node:tty") as typeof import("node:tty");
    const originalIsatty = ttyModule.isatty;
    ttyModule.isatty = (() => true) as typeof ttyModule.isatty;
    try {
      await expect(resolveOracle("pulse")).resolves.toEqual({
        repoPath: "/repos/Alt/pulse-oracle",
        repoName: "pulse-oracle",
        parentDir: "/repos/Alt",
      });
    } finally {
      ttyModule.isatty = originalIsatty;
    }
    expect(exitCodes).toEqual([]);
    expect(errors.some((line) => line.includes("matches 2 local oracles"))).toBe(true);
  });

  test("interactive ambiguity picker abort falls through after reporting the abort", async () => {
    ghqListValue = ["github.com/Org/pulse-oracle", "github.com/Alt/pulse-oracle"];
    resolveResults = [{
      kind: "ambiguous",
      candidates: [
        { owner: "Org", repo: "pulse-oracle", path: "/repos/Org/pulse-oracle" },
        { owner: "Alt", repo: "pulse-oracle", path: "/repos/Alt/pulse-oracle" },
      ],
    }];
    isattyValue = true;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    pickedOracle = null;
    scanSuggestResult = { repoPath: "/suggested/pulse-oracle", repoName: "pulse-oracle", parentDir: "/suggested" };

    const ttyModule = require("node:tty") as typeof import("node:tty");
    const originalIsatty = ttyModule.isatty;
    ttyModule.isatty = (() => true) as typeof ttyModule.isatty;
    try {
      await expect(resolveOracle("pulse")).resolves.toEqual(scanSuggestResult);
    } finally {
      ttyModule.isatty = originalIsatty;
    }
    expect(exitCodes).toContain(1);
    expect(errors.some((line) => line.includes("aborted"))).toBe(true);
  });

  test("uses stdin/stdout fallback when node tty probing fails and reports noninteractive ambiguity", async () => {
    ghqListValue = ["github.com/Org/pulse-oracle", "github.com/Alt/pulse-oracle"];
    resolveResults = [{
      kind: "ambiguous",
      candidates: [
        { owner: "Org", repo: "pulse-oracle", path: "/repos/Org/pulse-oracle" },
        { owner: "Alt", repo: "pulse-oracle", path: "/repos/Alt/pulse-oracle" },
      ],
    }];
    isattyThrows = true;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    scanSuggestResult = { repoPath: "/suggested/pulse-oracle", repoName: "pulse-oracle", parentDir: "/suggested" };

    await expect(resolveOracle("pulse")).resolves.toEqual(scanSuggestResult);
    expect(errors.some((line) => line.includes("use the full name: maw wake <org>/<repo>"))).toBe(true);
    expect(exitCodes).toContain(1);
  });
});

describe("worktree/session resolver fallback branches", () => {
  test("findWorktrees falls back to scoped slug lookup and shell-quotes apostrophes", async () => {
    hostExecHandler = async (cmd) => {
      if (cmd.startsWith("ls -d")) return "\n";
      if (cmd.includes("/neo-oracle/agents")) return "\n";
      return "/repos/o'rg/neo-oracle.wt-7-fix-login\n";
    };

    await expect(findWorktrees("/repos/o'rg", "neo-oracle", "fix-login", "neo-oracle")).resolves.toEqual([
      { path: "/repos/o'rg/neo-oracle.wt-7-fix-login", name: "7-fix-login" },
    ]);
    expect(hostExecCalls[0]).toContain("/repos/o'\\''rg");
    expect(hostExecCalls).toContain("find '/repos/o'\\''rg/neo-oracle/agents' -mindepth 1 -maxdepth 1 -type d 2>/dev/null || true");
    expect(hostExecCalls).toContain("find '/repos/o'\\''rg' -maxdepth 1 -type d -name 'neo-oracle.wt-*-fix-login' 2>/dev/null || true");
  });

  test("findReusableWorktreeBySlug handles unscoped matches, stat failures, and readdir failures", () => {
    const dir = join(parentRoot, "reuse");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    expect(findReusableWorktreeBySlug(dir, "blue", undefined, {
      readdirSync: () => ["z-oracle.wt-9-blue", "a-oracle.wt-1-blue", "a-oracle.wt-2-red"] as any,
      statSync: ((path: string) => {
        if (path.includes("z-oracle")) throw new Error("stat race");
        return { isDirectory: () => true } as any;
      }) as any,
    })).toEqual({ path: join(dir, "a-oracle.wt-1-blue"), name: "1-blue" });

    expect(findReusableWorktreeBySlug(dir, "blue", undefined, {
      readdirSync: (() => { throw new Error("permission denied"); }) as any,
    })).toBeNull();
  });

  test("resolveFleetSession ignores disabled configs, skips unreadable JSON, and detectSession ignores stale mapped sessions", async () => {
    writeFleet("disabled", { name: "disabled", windows: [{ name: "neo-oracle" }] });
    writeFileSync(join(fleetRoot, "disabled.json.disabled"), JSON.stringify({ windows: [{ name: "ignored-oracle" }] }));
    expect(resolveFleetSession("ignored")).toBeNull();

    writeFleet("broken", "{ not json");
    expect(resolveFleetSession("neo")).toBe("disabled");

    resetFleetDir();
    writeFleet("23-neo-admin", { name: "23-neo-admin", windows: [{ name: "neo-oracle" }] });
    config.sessions = { neo: "stale-neo" };
    sessions = [{ name: "23-neo-admin" }];
    await expect(detectSession("neo")).resolves.toBe("23-neo-admin");
  });

  test("detectSession scopes resolved repo names through fleet metadata before discord-like channel sessions", async () => {
    writeFleet("23-discord-admin", {
      name: "23-discord-admin",
      windows: [{ name: "discord-oracle", repo: "Soul-Brews-Studio/discord-oracle" }],
    });
    sessions = [
      { name: "01-mawjs-discord" },
      { name: "02-homekeeper-discord" },
      { name: "14-random-discord" },
      { name: "23-discord-admin" },
    ];

    await expect(detectSession("discord", "discord-oracle")).resolves.toBe("23-discord-admin");
  });

  test("detectSession filters discord channel helper sessions before generic suffix ambiguity", async () => {
    sessions = [
      { name: "01-mawjs-discord" },
      { name: "02-homekeeper-discord" },
      { name: "14-random-oracle-discord" },
    ];

    await expect(detectSession("discord")).resolves.toBeNull();
    expect(exitCodes).toEqual([]);
    expect(errors.join("\n")).not.toContain("ambiguous");
  });

  test("detectSession reports ambiguous numeric oracle-session matches before generic suffix matching", async () => {
    sessions = [
      { name: "24-discord-oracle" },
      { name: "25-discord-oracle" },
      { name: "99-homekeeper-discord" },
    ];

    await expect(detectSession("discord")).resolves.toBeNull();
    expect(exitCodes).toContain(1);
    expect(errors.join("\n")).toContain("'discord' is ambiguous — matches 2 fleet oracle sessions");
  });

  test("detectSession still accepts the oracle's own discord-oracle session shape", async () => {
    sessions = [
      { name: "01-mawjs-discord" },
      { name: "24-discord-oracle" },
      { name: "99-homekeeper-discord" },
    ];

    await expect(detectSession("discord")).resolves.toBe("24-discord-oracle");
    expect(exitCodes).toEqual([]);
  });
});
