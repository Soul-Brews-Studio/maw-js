/**
 * Sixth-pass isolated coverage for src/cli/cmd-update.ts.
 *
 * Covers retry-cleanup and restore-error branches that are awkward to hit from
 * the higher-level update suites. All process/Bun/filesystem boundaries are
 * mocked and all writes stay inside a temp HOME.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

let mockActive = false;

const _fs = await import("fs");
const _child = await import("child_process");
const _os = await import("os");
const _version = await import("../../src/cli/cmd-version");
const _ghq = await import("../../src/core/ghq");
const _lock = await import("../../src/cli/update-lock");

const real = {
  spawn: Bun.spawn,
  exit: process.exit,
  log: console.log,
  warn: console.warn,
  error: console.error,
  stdoutWrite: process.stdout.write,
  testMode: process.env.MAW_TEST_MODE,
  home: process.env.HOME,
  execSync: _child.execSync,
  homedir: _os.homedir,
  renameSync: _fs.renameSync,
  getVersionString: _version.getVersionString,
  ghqFindSync: _ghq.ghqFindSync,
  withUpdateLock: _lock.withUpdateLock,
};

type Capture = {
  code: number | undefined;
  stdout: string;
  stderr: string;
};

let tempRoot: string;
let homeDir: string;
let mawBin: string;
let currentVersion: string;
let afterVersion: string;
let execSyncCalls: string[];
let spawnCalls: string[][];
let spawnExitQueue: number[];
let lockCalls: number;
let addAttempts: number;
let createCacheAfterFirstAdd: boolean;
let failPkgRestore: boolean;
let failBinRestore: boolean;

function mkdirp(path: string): void {
  _fs.mkdirSync(path, { recursive: true });
}

function globalDir(): string {
  return join(homeDir, ".bun", "install", "global");
}

function nodeModulesDir(): string {
  return join(globalDir(), "node_modules");
}

function cacheDir(): string {
  return join(homeDir, ".bun", "install", "cache");
}

function pkgStashPath(): string {
  return join(nodeModulesDir(), "maw-js.update-stash");
}

function prepareInstallHome(): void {
  mkdirp(join(homeDir, ".bun", "bin"));
  mkdirp(nodeModulesDir());
  mkdirp(cacheDir());
  mkdirp(join(nodeModulesDir(), "maw-js"));
  mkdirp(join(cacheDir(), "maw-js-preflight-cache"));
  mkdirp(join(cacheDir(), "unrelated-preflight-cache"));

  _fs.writeFileSync(mawBin, "old working maw");
  _fs.writeFileSync(join(nodeModulesDir(), "maw-js", "package.json"), JSON.stringify({ name: "maw-js" }));
  _fs.writeFileSync(
    join(globalDir(), "package.json"),
    JSON.stringify({ dependencies: { "maw-js": "old-ref", maw: "old-bin", keep: "1" } }, null, 2),
  );
  _fs.writeFileSync(join(globalDir(), "bun.lock"), "old lock");
  _fs.writeFileSync(join(globalDir(), "bun.lockb"), "old binary lock");
}

async function captureRun(args: string[], opts: { testMode?: string | null } = {}): Promise<Capture> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let code: number | undefined;

  process.env.HOME = homeDir;
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
    const { runUpdate } = await import("../../src/cli/cmd-update");
    await runUpdate(args);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("exit:")) throw err;
  }

  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

mock.module("fs", () => ({
  ..._fs,
  renameSync: (oldPath: _fs.PathLike, newPath: _fs.PathLike) => {
    if (mockActive && failPkgRestore && String(oldPath) === pkgStashPath() && String(newPath) === join(nodeModulesDir(), "maw-js")) {
      throw new Error("pkg restore blocked");
    }
    if (mockActive && failBinRestore && String(oldPath) === `${mawBin}.prev` && String(newPath) === mawBin) {
      throw new Error("bin restore blocked");
    }
    return real.renameSync(oldPath, newPath);
  },
}));

mock.module("child_process", () => ({
  ..._child,
  execSync: (cmd: string, opts?: any) => {
    if (!mockActive) return real.execSync(cmd, opts);
    execSyncCalls.push(cmd);
    if (cmd === "maw --version") return `${afterVersion}\n`;
    if (cmd === "which maw") return `${mawBin}\n`;
    return "";
  },
}));

mock.module("os", () => ({
  ..._os,
  homedir: () => (mockActive ? homeDir : real.homedir()),
}));

mock.module(join(import.meta.dir, "../../src/cli/cmd-version"), () => ({
  ..._version,
  getVersionString: () => (mockActive ? currentVersion : real.getVersionString()),
}));

mock.module(join(import.meta.dir, "../../src/core/ghq"), () => ({
  ..._ghq,
  ghqFindSync: (suffix: string) => (mockActive ? null : real.ghqFindSync(suffix)),
}));

mock.module(join(import.meta.dir, "../../src/cli/update-lock"), () => ({
  ..._lock,
  withUpdateLock: async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (!mockActive) return real.withUpdateLock(fn);
    lockCalls += 1;
    return await fn();
  },
}));

beforeEach(() => {
  mockActive = true;
  tempRoot = _fs.mkdtempSync(join(_os.tmpdir(), "maw-update-sixth-pass-"));
  homeDir = join(tempRoot, "home");
  mawBin = join(homeDir, ".bun", "bin", "maw");
  currentVersion = "maw v26.5.16-alpha.1052";
  afterVersion = "maw v26.5.16-alpha.1053";
  execSyncCalls = [];
  spawnCalls = [];
  spawnExitQueue = [];
  lockCalls = 0;
  addAttempts = 0;
  createCacheAfterFirstAdd = false;
  failPkgRestore = false;
  failBinRestore = false;

  (Bun as any).spawn = (cmd: string[], opts?: any) => {
    if (!mockActive) return real.spawn(cmd as any, opts);
    const code = spawnExitQueue.length ? spawnExitQueue.shift()! : 0;
    spawnCalls.push([...cmd]);

    if (cmd[0] === "bun" && cmd[1] === "add") {
      addAttempts += 1;
      if (addAttempts === 1 && createCacheAfterFirstAdd) {
        mkdirp(join(cacheDir(), "maw-js-after-first-fail"));
        mkdirp(join(cacheDir(), "unrelated-after-first-fail"));
      }
    }

    return { exited: Promise.resolve(code) };
  };
});

afterEach(() => {
  mockActive = false;
  (Bun as any).spawn = real.spawn;
  (process as any).exit = real.exit;
  console.log = real.log;
  console.warn = real.warn;
  console.error = real.error;
  (process.stdout as any).write = real.stdoutWrite;
  if (real.testMode === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = real.testMode;
  if (real.home === undefined) delete process.env.HOME;
  else process.env.HOME = real.home;
  if (tempRoot && _fs.existsSync(tempRoot)) _fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("cmd-update sixth-pass retry cleanup coverage", () => {
  test("retry cleanup removes maw-js cache entries created after preflight resolver cleanup", async () => {
    prepareInstallHome();
    createCacheAfterFirstAdd = true;
    spawnExitQueue = [1, 0, 0];

    const res = await captureRun(["update", "v26.5.16-alpha.1053", "--yes"], { testMode: null });

    expect(res.code).toBeUndefined();
    expect(lockCalls).toBe(1);
    expect(spawnCalls).toEqual([
      ["bun", "add", "-g", "github:Soul-Brews-Studio/maw-js#v26.5.16-alpha.1053"],
      ["bun", "add", "-g", "github:Soul-Brews-Studio/maw-js#v26.5.16-alpha.1053"],
      ["maw", "--version"],
    ]);
    expect(execSyncCalls).toContain("maw --version");
    expect(res.stderr).toContain("first install attempt failed");
    expect(res.stdout).toContain("✅");
    expect(_fs.existsSync(join(cacheDir(), "maw-js-after-first-fail"))).toBe(false);
    expect(_fs.existsSync(join(cacheDir(), "unrelated-after-first-fail"))).toBe(true);
  });

  test("total failure reports package-stash and bin-stash restore errors", async () => {
    prepareInstallHome();
    failPkgRestore = true;
    failBinRestore = true;
    spawnExitQueue = [1, 1, 1];

    const res = await captureRun(["update", "v26.5.16-alpha.1053", "--yes"], { testMode: null });

    expect(res.code).toBe(1);
    expect(lockCalls).toBe(1);
    expect(spawnCalls).toEqual([
      ["bun", "add", "-g", "github:Soul-Brews-Studio/maw-js#v26.5.16-alpha.1053"],
      ["bun", "add", "-g", "github:Soul-Brews-Studio/maw-js#v26.5.16-alpha.1053"],
      ["curl", "-fsSL", "-o", mawBin, "https://github.com/Soul-Brews-Studio/maw-js/releases/download/v26.5.16-alpha.1053/maw"],
    ]);
    expect(res.stderr).toContain("failed to restore maw-js package from stash: pkg restore blocked");
    expect(res.stderr).toContain("failed to restore stash: bin restore blocked");
    expect(res.stderr).toContain("previous maw restored from stash (if available)");
    expect(_fs.existsSync(pkgStashPath())).toBe(true);
    expect(_fs.existsSync(`${mawBin}.prev`)).toBe(true);
  });
});
