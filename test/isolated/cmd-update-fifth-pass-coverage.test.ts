/**
 * Fifth-pass isolated coverage for src/cli/cmd-update.ts.
 *
 * Keep this file self-contained: it mocks the destructive install boundary and
 * only writes inside temp HOME roots. The goal is to cover runtime branches not
 * exercised by the direct/helper/order/ref-validation/stash suites.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join, dirname } from "path";

let mockActive = false;

const _fs = await import("fs");
const _child = await import("child_process");
const _os = await import("os");
const _version = await import("../../src/cli/cmd-version");
const _ghq = await import("../../src/core/ghq");
const _lock = await import("../../src/cli/update-lock");

const fsReal = {
  openSync: _fs.openSync,
  readSync: _fs.readSync,
  closeSync: _fs.closeSync,
  renameSync: _fs.renameSync,
};

const real = {
  spawn: Bun.spawn,
  exit: process.exit,
  log: console.log,
  warn: console.warn,
  error: console.error,
  stdoutWrite: process.stdout.write,
  stdinIsTTY: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
  testMode: process.env.MAW_TEST_MODE,
  home: process.env.HOME,
  execSync: _child.execSync,
  homedir: _os.homedir,
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
let cloneDir: string;
let currentVersion: string;
let afterVersion: string;
let ghqFindReturn: string | null;
let execVersionThrows: boolean;
let execSyncCalls: string[];
let spawnCalls: string[][];
let spawnExitQueue: number[];
let lockCalls: number;
let ttyAnswer: string;
let ttyOpenCalls: number;
let ttyReadCalls: number;
let ttyCloseCalls: number;
let failStashRotation: boolean;

function mkdirp(path: string): void {
  _fs.mkdirSync(path, { recursive: true });
}

function prepareInstallHome(version = "26.5.16-alpha.1053"): void {
  const bunBin = dirname(mawBin);
  const global = join(homeDir, ".bun", "install", "global");
  const nodeModules = join(global, "node_modules");
  const cache = join(homeDir, ".bun", "install", "cache");

  mkdirp(bunBin);
  mkdirp(nodeModules);
  mkdirp(cache);
  mkdirp(join(nodeModules, "maw-js"));
  mkdirp(join(cache, "maw-js-old"));

  _fs.writeFileSync(join(nodeModules, "maw-js", "package.json"), JSON.stringify({ name: "maw-js", version }));
  _fs.writeFileSync(
    join(global, "package.json"),
    JSON.stringify({ dependencies: { "maw-js": "old-ref", maw: "old-bin", keep: "1" } }, null, 2),
  );
  _fs.writeFileSync(join(global, "bun.lock"), "old lock");
  _fs.writeFileSync(join(global, "bun.lockb"), "old binary lock");
  _fs.writeFileSync(mawBin, "old working maw");
}

function prepareLocalClone(version: string): void {
  mkdirp(cloneDir);
  _fs.writeFileSync(join(cloneDir, "package.json"), JSON.stringify({ version }));
}

function prepareBundledPluginRoot(): void {
  const pluginRoot = join(dirname(mawBin), "commands", "plugins");
  mkdirp(join(pluginRoot, "runtime-plugin"));
  _fs.writeFileSync(join(pluginRoot, "runtime-plugin", "plugin.json"), "{}");
}

function prepareBrokenUserPluginSymlinks(count: number): void {
  const pluginDir = join(homeDir, ".maw", "plugins");
  mkdirp(pluginDir);
  for (let i = 1; i <= count; i++) {
    _fs.symlinkSync(join(homeDir, "missing", `lost-${i}`), join(pluginDir, `lost-${i}`));
  }
}

function packageDependencies(): Record<string, string> {
  return JSON.parse(_fs.readFileSync(join(homeDir, ".bun", "install", "global", "package.json"), "utf-8")).dependencies;
}

function setStdinIsTTY(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
}

async function captureRun(
  args: string[],
  opts: { testMode?: string | null; stdinIsTTY?: boolean } = {},
): Promise<Capture> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let code: number | undefined;

  process.env.HOME = homeDir;
  if (opts.testMode === null) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = opts.testMode ?? "1";
  if (opts.stdinIsTTY !== undefined) setStdinIsTTY(opts.stdinIsTTY);

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
  openSync: (path: _fs.PathLike, flags: string | number, mode?: _fs.Mode) => {
    if (mockActive && path === "/dev/tty") {
      ttyOpenCalls += 1;
      return 98_765;
    }
    return fsReal.openSync(path, flags as any, mode as any);
  },
  readSync: (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: _fs.ReadPosition | null) => {
    if (mockActive && fd === 98_765 && Buffer.isBuffer(buffer)) {
      ttyReadCalls += 1;
      const bytes = Buffer.from(ttyAnswer);
      bytes.copy(buffer, offset, 0, Math.min(length, bytes.length));
      return Math.min(length, bytes.length);
    }
    return fsReal.readSync(fd, buffer, offset, length, position);
  },
  closeSync: (fd: number) => {
    if (mockActive && fd === 98_765) {
      ttyCloseCalls += 1;
      return;
    }
    return fsReal.closeSync(fd);
  },
  renameSync: (oldPath: _fs.PathLike, newPath: _fs.PathLike) => {
    if (
      mockActive
      && failStashRotation
      && String(oldPath) === `${mawBin}.prev`
      && String(newPath).includes(".crash.")
    ) {
      throw new Error("rename blocked");
    }
    return fsReal.renameSync(oldPath, newPath);
  },
}));

mock.module("child_process", () => ({
  ..._child,
  execSync: (cmd: string, opts?: any) => {
    if (!mockActive) return real.execSync(cmd, opts);
    execSyncCalls.push(cmd);

    if (cmd === "maw --version") {
      if (execVersionThrows) throw new Error("maw missing");
      return `${afterVersion}\n`;
    }
    if (cmd === "which maw") return `${mawBin}\n`;
    if (cmd.includes("git ls-remote")) return "";
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
  ghqFindSync: (suffix: string) => (mockActive ? ghqFindReturn : real.ghqFindSync(suffix)),
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
  tempRoot = _fs.mkdtempSync(join(_os.tmpdir(), "maw-update-fifth-pass-"));
  homeDir = join(tempRoot, "home");
  mawBin = join(homeDir, ".bun", "bin", "maw");
  cloneDir = join(tempRoot, "maw-js-clone");
  currentVersion = "maw v26.5.16-alpha.1052";
  afterVersion = "maw v26.5.16-alpha.1053";
  ghqFindReturn = null;
  execVersionThrows = false;
  execSyncCalls = [];
  spawnCalls = [];
  spawnExitQueue = [];
  lockCalls = 0;
  ttyAnswer = "n\n";
  ttyOpenCalls = 0;
  ttyReadCalls = 0;
  ttyCloseCalls = 0;
  failStashRotation = false;

  (Bun as any).spawn = (cmd: string[], opts?: any) => {
    if (!mockActive) return real.spawn(cmd as any, opts);
    const code = spawnExitQueue.length ? spawnExitQueue.shift()! : 0;
    spawnCalls.push([...cmd]);
    if (cmd[0] === "curl" && code === 0) {
      _fs.writeFileSync(cmd[3], "downloaded maw");
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
  if (real.stdinIsTTY) Object.defineProperty(process.stdin, "isTTY", real.stdinIsTTY);
  else delete (process.stdin as any).isTTY;
  if (real.testMode === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = real.testMode;
  if (real.home === undefined) delete process.env.HOME;
  else process.env.HOME = real.home;
  if (tempRoot && _fs.existsSync(tempRoot)) _fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("cmd-update fifth-pass runtime branches", () => {
  test("interactive TTY prompt aborts cleanly when the answer is not yes", async () => {
    ttyAnswer = "no\n";

    const res = await captureRun(["update", "main"], { testMode: "1", stdinIsTTY: true });

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("proceed? [y/N]");
    expect(res.stdout).toContain("aborted");
    expect(res.stdout).not.toContain("[test-mode]");
    expect(res.stderr).toBe("");
    expect(ttyOpenCalls).toBe(1);
    expect(ttyReadCalls).toBe(1);
    expect(ttyCloseCalls).toBe(1);
  });

  test("interactive TTY prompt accepts uppercase YES and reaches the test-mode boundary", async () => {
    ttyAnswer = "YES\n";

    const res = await captureRun(["update", "feature/tty-confirm"], { testMode: "1", stdinIsTTY: true });

    expect(res.code).toBeUndefined();
    expect(res.stdout).toContain("proceed? [y/N]");
    expect(res.stdout).toContain('[test-mode] ref "feature/tty-confirm" accepted');
    expect(res.stderr).toBe("");
    expect(ttyOpenCalls).toBe(1);
    expect(ttyReadCalls).toBe(1);
    expect(ttyCloseCalls).toBe(1);
  });

  test("stale .prev rotation failure refuses before retrying or overwriting the stash", async () => {
    prepareInstallHome();
    _fs.writeFileSync(`${mawBin}.prev`, "previous crash stash");
    failStashRotation = true;
    spawnExitQueue = [1];

    const res = await captureRun(["update", "v26.5.16-alpha.1053", "--yes"], { testMode: null });

    expect(res.code).toBe(1);
    expect(lockCalls).toBe(1);
    expect(spawnCalls).toEqual([
      ["bun", "add", "-g", "github:Soul-Brews-Studio/maw-js#v26.5.16-alpha.1053"],
    ]);
    expect(res.stderr).toContain("could not be rotated: rename blocked");
    expect(res.stderr).toContain("resolve manually");
    expect(_fs.readFileSync(`${mawBin}.prev`, "utf-8")).toBe("previous crash stash");
  });

  test("stale .prev rotation success preserves crash copy and continues retry install", async () => {
    prepareInstallHome();
    _fs.writeFileSync(`${mawBin}.prev`, "previous crash stash");
    spawnExitQueue = [1, 0, 0];

    const res = await captureRun(["update", "v26.5.16-alpha.1053", "--yes"], { testMode: null });

    expect(res.code).toBeUndefined();
    expect(spawnCalls).toEqual([
      ["bun", "add", "-g", "github:Soul-Brews-Studio/maw-js#v26.5.16-alpha.1053"],
      ["bun", "add", "-g", "github:Soul-Brews-Studio/maw-js#v26.5.16-alpha.1053"],
      ["maw", "--version"],
    ]);
    expect(res.stderr).toContain("rotated stale");
    const crashStashes = _fs.readdirSync(dirname(mawBin)).filter((entry) => entry.startsWith("maw.prev.crash."));
    expect(crashStashes).toHaveLength(1);
    expect(_fs.readFileSync(join(dirname(mawBin), crashStashes[0]), "utf-8")).toBe("previous crash stash");
    expect(_fs.existsSync(`${mawBin}.prev`)).toBe(false);
  });

  test("release-binary fallback success verifies the fresh binary, discards stashes, and reports pruned plugin links", async () => {
    prepareInstallHome();
    prepareLocalClone("26.5.16-alpha.9999");
    prepareBundledPluginRoot();
    prepareBrokenUserPluginSymlinks(2);
    ghqFindReturn = cloneDir;
    spawnExitQueue = [1, 1, 0, 0, 0];

    const res = await captureRun(["update", "v26.5.16-alpha.1053", "--yes"], { testMode: null });

    expect(res.code).toBeUndefined();
    expect(spawnCalls).toEqual([
      ["bun", "add", "-g", "github:Soul-Brews-Studio/maw-js#v26.5.16-alpha.1053"],
      ["bun", "add", "-g", "github:Soul-Brews-Studio/maw-js#v26.5.16-alpha.1053"],
      ["curl", "-fsSL", "-o", mawBin, "https://github.com/Soul-Brews-Studio/maw-js/releases/download/v26.5.16-alpha.1053/maw"],
      ["chmod", "+x", mawBin],
      ["maw", "--version"],
      ["maw", "--version"],
    ]);
    expect(res.stderr).toContain("first install attempt failed");
    expect(res.stderr).toContain("bun add failed — trying release-binary fallback");
    expect(res.stdout).toContain("installed via release binary");
    expect(res.stdout).toContain("SDK link skipped");
    expect(res.stdout).toContain("bundled plugins re-linked");
    expect(res.stdout).toContain("removed 2 broken plugin symlinks");
    expect(_fs.existsSync(`${mawBin}.prev`)).toBe(false);
    expect(_fs.existsSync(join(homeDir, ".bun", "install", "global", "node_modules", "maw-js.update-stash"))).toBe(false);
    expect(_fs.existsSync(join(homeDir, ".maw", "plugins", "runtime-plugin", "plugin.json"))).toBe(true);
    expect(_fs.existsSync(join(homeDir, ".maw", "plugins", "lost-1"))).toBe(false);
    expect(_fs.existsSync(join(homeDir, ".maw", "plugins", "lost-2"))).toBe(false);
  });

  test("retry success rolls back when the fresh binary verification fails", async () => {
    prepareInstallHome();
    spawnExitQueue = [1, 0, 1];

    const res = await captureRun(["update", "v26.5.16-alpha.1053", "--yes"], { testMode: null });

    expect(res.code).toBe(1);
    expect(spawnCalls).toEqual([
      ["bun", "add", "-g", "github:Soul-Brews-Studio/maw-js#v26.5.16-alpha.1053"],
      ["bun", "add", "-g", "github:Soul-Brews-Studio/maw-js#v26.5.16-alpha.1053"],
      ["maw", "--version"],
    ]);
    expect(res.stderr).toContain("fresh install did not run — rolling back to previous maw");
    expect(res.stderr).toContain("previous maw restored from stash");
    expect(_fs.readFileSync(mawBin, "utf-8")).toBe("old working maw");
    expect(packageDependencies()).toEqual({ "maw-js": "old-ref", maw: "old-bin", keep: "1" });
    expect(_fs.existsSync(join(homeDir, ".bun", "install", "global", "node_modules", "maw-js"))).toBe(true);
    expect(_fs.existsSync(join(homeDir, ".bun", "install", "global", "node_modules", "maw-js.update-stash"))).toBe(false);
  });

  test("successful install still completes with generic done when after-version probing fails", async () => {
    prepareInstallHome();
    execVersionThrows = true;
    spawnExitQueue = [0];

    const res = await captureRun(["update", "main", "--yes"], { testMode: null });

    expect(res.code).toBeUndefined();
    expect(spawnCalls).toEqual([
      ["bun", "add", "-g", "github:Soul-Brews-Studio/maw-js#main"],
    ]);
    expect(execSyncCalls).toContain("maw --version");
    expect(res.stdout).toContain("✅ done");
  });
});
