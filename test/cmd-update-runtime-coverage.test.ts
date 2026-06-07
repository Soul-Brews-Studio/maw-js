/**
 * Runtime coverage for maw update's install path without touching the real
 * Bun global install. Mocks are gated and delegate when inactive so this main
 * suite file contributes to `test:coverage` without polluting other tests.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

let mockActive = false;

const _rChild = await import("child_process");
const _rOs = await import("os");
const _rVersion = await import("../src/cli/cmd-version");
const _rGhq = await import("../src/core/ghq");
const _rUpdateLock = await import("../src/cli/update-lock");

const realChild = { execSync: _rChild.execSync };
const realOs = { homedir: _rOs.homedir };
const realVersion = { getVersionString: _rVersion.getVersionString };
const realGhq = { ghqFindSync: _rGhq.ghqFindSync };
const realUpdateLock = { withUpdateLock: _rUpdateLock.withUpdateLock };

let tempRoot: string;
let homeDir: string;
let mawBin: string;
let cloneDir: string;
let currentVersion: string;
let ghqFindReturn: string | null;
let execSyncCalls: string[];
let spawnCalls: string[][];
let spawnExitQueue: number[];
let lsRemoteOutput: string;
let execThrow: Error | null;
let lockCalls: number;

const original = {
  spawn: Bun.spawn,
  exit: process.exit,
  log: console.log,
  warn: console.warn,
  error: console.error,
  stdoutWrite: process.stdout.write,
  testMode: process.env.MAW_TEST_MODE,
  home: process.env.HOME,
  mawHome: process.env.MAW_HOME,
  mawDataDir: process.env.MAW_DATA_DIR,
  mawXdg: process.env.MAW_XDG,
};

type Capture = {
  code: number | undefined;
  stdout: string;
  stderr: string;
  threw: unknown;
};

function mkdirp(path: string): void {
  mkdirSync(path, { recursive: true });
}

function prepareInstallHome(version = "26.5.16-alpha.1053"): void {
  const bunBin = join(homeDir, ".bun", "bin");
  const global = join(homeDir, ".bun", "install", "global");
  const nodeModules = join(global, "node_modules");
  const cache = join(homeDir, ".bun", "install", "cache");
  mkdirp(bunBin);
  mkdirp(nodeModules);
  mkdirp(cache);
  mkdirp(join(nodeModules, "maw-js"));
  mkdirp(join(cache, "maw-js-old"));
  writeFileSync(join(nodeModules, "maw-js", "package.json"), JSON.stringify({ name: "maw-js", version }));
  writeFileSync(join(global, "package.json"), JSON.stringify({ dependencies: { "maw-js": "old", maw: "old", keep: "1" } }, null, 2));
  writeFileSync(join(global, "bun.lock"), "old lock");
  writeFileSync(join(global, "bun.lockb"), "old binary lock");
  writeFileSync(mawBin, "#!/bin/sh\necho maw\n");
}

function prepareLocalClone(version = "26.5.16-alpha.1053"): void {
  mkdirp(cloneDir);
  writeFileSync(join(cloneDir, "package.json"), JSON.stringify({ version }));
}

function prepareBundledPluginRoot(): void {
  const mawSrc = join(homeDir, ".bun", "bin");
  const pluginRoot = join(mawSrc, "commands", "plugins");
  mkdirp(join(pluginRoot, "runtime-plugin"));
  writeFileSync(join(pluginRoot, "runtime-plugin", "plugin.json"), "{}");
}

async function captureRun(
  args: string[],
  opts: { testMode?: string | null } = {},
): Promise<Capture> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let code: number | undefined;
  let threw: unknown;

  process.env.HOME = homeDir;
  delete process.env.MAW_HOME;
  delete process.env.MAW_DATA_DIR;
  delete process.env.MAW_XDG;
  if (opts.testMode === null) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = opts.testMode ?? "1";

  (process as any).exit = (exitCode?: number) => {
    code = exitCode ?? 0;
    throw new Error(`exit:${code}`);
  };
  console.log = (...parts: unknown[]) => { stdout.push(parts.map(String).join(" ")); };
  console.warn = (...parts: unknown[]) => { stderr.push(parts.map(String).join(" ")); };
  console.error = (...parts: unknown[]) => { stderr.push(parts.map(String).join(" ")); };
  (process.stdout as any).write = (chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  };

  try {
    const { runUpdate } = await import("../src/cli/cmd-update");
    await runUpdate(args);
  } catch (err) {
    threw = err;
    if (!(err instanceof Error) || !err.message.startsWith("exit:")) throw err;
  }

  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n"), threw };
}

mock.module("child_process", () => ({
  ..._rChild,
  execSync: (cmd: string, opts?: any) => {
    if (!mockActive) return realChild.execSync(cmd, opts);
    execSyncCalls.push(cmd);
    if (execThrow) throw execThrow;
    if (cmd.includes("git ls-remote")) return lsRemoteOutput;
    if (cmd === "which maw") return `${mawBin}\n`;
    if (cmd === "maw --version") return `${currentVersion}\n`;
    return "";
  },
}));

mock.module("os", () => ({
  ..._rOs,
  homedir: () => (mockActive ? homeDir : realOs.homedir()),
}));

mock.module(join(import.meta.dir, "../src/cli/cmd-version"), () => ({
  ..._rVersion,
  getVersionString: () => (mockActive ? currentVersion : realVersion.getVersionString()),
}));

mock.module(join(import.meta.dir, "../src/core/ghq"), () => ({
  ..._rGhq,
  ghqFindSync: (suffix: string) =>
    mockActive ? ghqFindReturn : realGhq.ghqFindSync(suffix),
}));

mock.module(join(import.meta.dir, "../src/cli/update-lock"), () => ({
  ..._rUpdateLock,
  withUpdateLock: async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (!mockActive) return realUpdateLock.withUpdateLock(fn);
    lockCalls += 1;
    return await fn();
  },
}));

beforeEach(() => {
  mockActive = true;
  tempRoot = mkdtempSync(join(tmpdir(), "maw-update-runtime-"));
  homeDir = join(tempRoot, "home");
  mawBin = join(homeDir, ".bun", "bin", "maw");
  cloneDir = join(tempRoot, "maw-js-clone");
  currentVersion = "maw v26.5.16-alpha.1053";
  ghqFindReturn = cloneDir;
  execSyncCalls = [];
  spawnCalls = [];
  spawnExitQueue = [];
  lsRemoteOutput = [
    "111111\trefs/tags/v26.5.15-alpha.2350",
    "222222\trefs/tags/v26.5.16-alpha.716",
    "333333\trefs/tags/v26.5.16-alpha.1053",
    "444444\trefs/tags/v26.5.16-beta.10",
    "555555\trefs/tags/not-maw",
  ].join("\n");
  execThrow = null;
  lockCalls = 0;

  (Bun as any).spawn = (cmd: string[]) => {
    if (!mockActive) return original.spawn(cmd as any);
    spawnCalls.push([...cmd]);
    const code = spawnExitQueue.length ? spawnExitQueue.shift()! : 0;
    return { exited: Promise.resolve(code) };
  };
});

afterEach(() => {
  mockActive = false;
  (Bun as any).spawn = original.spawn;
  (process as any).exit = original.exit;
  console.log = original.log;
  console.warn = original.warn;
  console.error = original.error;
  (process.stdout as any).write = original.stdoutWrite;
  if (original.testMode === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = original.testMode;
  if (original.home === undefined) delete process.env.HOME;
  else process.env.HOME = original.home;
  if (original.mawHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = original.mawHome;
  if (original.mawDataDir === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = original.mawDataDir;
  if (original.mawXdg === undefined) delete process.env.MAW_XDG;
  else process.env.MAW_XDG = original.mawXdg;
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

describe("cmd-update runtime coverage", () => {
  test("resolves the alpha channel to the latest calver tag before the test-mode boundary", async () => {
    const res = await captureRun(["update", "alpha", "--yes"], { testMode: "1" });

    expect(res.code).toBeUndefined();
    expect(execSyncCalls).toContain("git ls-remote --tags --refs https://github.com/Soul-Brews-Studio/maw-js.git");
    expect(res.stdout).toContain("alpha channel → v26.5.16-alpha.1053");
    expect(res.stdout).toContain('[test-mode] ref "v26.5.16-alpha.1053" accepted');
  });

  test("alpha channel sort tolerates duplicate tags and still chooses the newest ref", async () => {
    lsRemoteOutput = [
      "111111\trefs/tags/v26.5.16-alpha.1053",
      "222222\trefs/tags/v26.5.16-alpha.1053",
      "333333\trefs/tags/v26.5.16-alpha.716",
    ].join("\n");

    const res = await captureRun(["update", "alpha", "--yes"], { testMode: "1" });

    expect(res.code).toBeUndefined();
    expect(res.stdout).toContain("alpha channel → v26.5.16-alpha.1053");
    expect(spawnCalls).toHaveLength(0);
  });

  test("invalid positional refs fail before test-mode or install side effects", async () => {
    const res = await captureRun(["update", "bad;ref", "--yes"], { testMode: "1" });

    expect(res.code).toBe(1);
    expect(res.stderr).toContain('invalid ref "bad;ref"');
    expect(res.stdout).not.toContain("[test-mode]");
    expect(spawnCalls).toHaveLength(0);
  });

  test("fails loudly when a requested channel has no release tags", async () => {
    lsRemoteOutput = "111111\trefs/tags/v26.5.16-alpha.716\n";

    const res = await captureRun(["update", "beta", "--yes"], { testMode: "1" });

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no beta tags");
    expect(spawnCalls).toHaveLength(0);
  });

  test("surfaces ls-remote failures while resolving a channel", async () => {
    execThrow = new Error("network down");

    const res = await captureRun(["update", "alpha", "--yes"], { testMode: "1" });

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("failed to resolve alpha channel: network down");
    expect(spawnCalls).toHaveLength(0);
  });

  test("runs the successful install path under the update lock and refreshes SDK/plugin links", async () => {
    prepareInstallHome();
    prepareLocalClone();
    prepareBundledPluginRoot();
    spawnExitQueue = [0];

    const res = await captureRun(["update", "v26.5.16-alpha.1053", "--yes"], { testMode: null });

    expect(res.code).toBeUndefined();
    expect(lockCalls).toBe(1);
    expect(spawnCalls).toEqual([
      ["bun", "add", "-g", "github:Soul-Brews-Studio/maw-js#v26.5.16-alpha.1053"],
    ]);
    expect(execSyncCalls).toContain(`cd ${cloneDir} && bun link`);
    expect(execSyncCalls).toContain(`cd ${join(homeDir, ".maw", "oracle-plugins")} && bun link maw`);
    expect(execSyncCalls).toContain("which maw");
    expect(existsSync(join(homeDir, ".maw", "plugins", "runtime-plugin", "plugin.json"))).toBe(true);
    expect(res.stdout).toContain("SDK linked");
    expect(res.stdout).toContain("bundled plugins re-linked");
    expect(res.stdout).toContain("✅");
  });

  test("restores binary and package stashes when install, retry, and release fallback all fail", async () => {
    prepareInstallHome();
    writeFileSync(mawBin, "old working maw");
    spawnExitQueue = [1, 1, 1];

    const res = await captureRun(["update", "v26.5.16-alpha.1053", "--yes"], { testMode: null });

    expect(res.code).toBe(1);
    expect(spawnCalls).toEqual([
      ["bun", "add", "-g", "github:Soul-Brews-Studio/maw-js#v26.5.16-alpha.1053"],
      ["bun", "add", "-g", "github:Soul-Brews-Studio/maw-js#v26.5.16-alpha.1053"],
      ["curl", "-fsSL", "-o", mawBin, "https://github.com/Soul-Brews-Studio/maw-js/releases/download/v26.5.16-alpha.1053/maw"],
    ]);
    expect(res.stderr).toContain("first install attempt failed");
    expect(res.stderr).toContain("bun add failed — trying release-binary fallback");
    expect(res.stderr).toContain("restored previous maw binary from stash");
    expect(res.stderr).toContain("previous maw restored from stash");
    expect(readFileSync(mawBin, "utf-8")).toBe("old working maw");
    expect(existsSync(`${mawBin}.prev`)).toBe(false);
    expect(existsSync(join(homeDir, ".bun", "install", "global", "node_modules", "maw-js"))).toBe(true);
    expect(existsSync(join(homeDir, ".bun", "install", "global", "node_modules", "maw-js.update-stash"))).toBe(false);
    const restoredPkg = JSON.parse(readFileSync(join(homeDir, ".bun", "install", "global", "package.json"), "utf-8"));
    expect(restoredPkg.dependencies["maw-js"]).toBe("old");
    expect(restoredPkg.dependencies.maw).toBe("old");
  });
});
