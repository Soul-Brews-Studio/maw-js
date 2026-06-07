/**
 * Seventh-pass isolated coverage for src/cli/cmd-update.ts.
 *
 * Covers cheap executable branches left after the runtime fallback suites:
 * help/flag/ref gates, channel resolution, plugin symlink healing with a
 * replacement, rollback restore errors, and SDK link success. All destructive
 * boundaries are mocked and writes stay inside temp HOME roots.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { dirname, join } from "path";

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
  stdinIsTTY: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
  testMode: process.env.MAW_TEST_MODE,
  home: process.env.HOME,
  mawHome: process.env.MAW_HOME,
  mawDataDir: process.env.MAW_DATA_DIR,
  mawXdg: process.env.MAW_XDG,
  execSync: _child.execSync,
  renameSync: _fs.renameSync,
  homedir: _os.homedir,
  getVersionString: _version.getVersionString,
  ghqFindSync: _ghq.ghqFindSync,
  withUpdateLock: _lock.withUpdateLock,
};

type Capture = { code: number | undefined; stdout: string; stderr: string };

let tempRoot = "";
let homeDir = "";
let mawBin = "";
let cloneDir = "";
let currentVersion = "";
let afterVersion = "";
let ghqFindReturn: string | null = null;
let gitLsRemoteOutput = "";
let gitLsRemoteThrows: Error | null = null;
let execSyncCalls: string[] = [];
let spawnCalls: string[][] = [];
let spawnExitQueue: number[] = [];
let lockCalls = 0;
let failRollbackBinRestore = false;

function mkdirp(path: string): void {
  _fs.mkdirSync(path, { recursive: true });
}

function globalDir(): string {
  return join(homeDir, ".bun", "install", "global");
}

function nodeModulesDir(): string {
  return join(globalDir(), "node_modules");
}

function prepareInstallHome(): void {
  mkdirp(dirname(mawBin));
  mkdirp(nodeModulesDir());
  mkdirp(join(homeDir, ".bun", "install", "cache"));
  mkdirp(join(nodeModulesDir(), "maw-js"));
  _fs.writeFileSync(mawBin, "old working maw");
  _fs.writeFileSync(join(nodeModulesDir(), "maw-js", "package.json"), JSON.stringify({ name: "maw-js" }));
  _fs.writeFileSync(
    join(globalDir(), "package.json"),
    JSON.stringify({ dependencies: { "maw-js": "old-ref", maw: "old-bin", keep: "1" } }, null, 2),
  );
}

function prepareClone(version: string): void {
  mkdirp(cloneDir);
  _fs.writeFileSync(join(cloneDir, "package.json"), JSON.stringify({ version }));
}

function setStdinIsTTY(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
}

async function captureRun(args: string[], opts: { testMode?: string | null; stdinIsTTY?: boolean } = {}): Promise<Capture> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let code: number | undefined;

  process.env.HOME = homeDir;
  delete process.env.MAW_HOME;
  delete process.env.MAW_DATA_DIR;
  delete process.env.MAW_XDG;
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
  renameSync: (oldPath: _fs.PathLike, newPath: _fs.PathLike) => {
    if (mockActive && failRollbackBinRestore && String(oldPath) === `${mawBin}.prev` && String(newPath) === mawBin) {
      throw new Error("rollback bin restore blocked");
    }
    return real.renameSync(oldPath, newPath);
  },
}));

mock.module("child_process", () => ({
  ..._child,
  execSync: (cmd: string, opts?: any) => {
    if (!mockActive) return real.execSync(cmd, opts);
    execSyncCalls.push(cmd);
    if (cmd.includes("git ls-remote")) {
      if (gitLsRemoteThrows) throw gitLsRemoteThrows;
      return gitLsRemoteOutput;
    }
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
  tempRoot = _fs.mkdtempSync(join(_os.tmpdir(), "maw-update-seventh-pass-"));
  homeDir = join(tempRoot, "home");
  mawBin = join(homeDir, ".bun", "bin", "maw");
  cloneDir = join(tempRoot, "maw-js-clone");
  currentVersion = "maw v26.5.16-alpha.1052";
  afterVersion = "maw v26.5.16-alpha.1053";
  ghqFindReturn = null;
  gitLsRemoteOutput = "";
  gitLsRemoteThrows = null;
  execSyncCalls = [];
  spawnCalls = [];
  spawnExitQueue = [];
  lockCalls = 0;
  failRollbackBinRestore = false;

  (Bun as any).spawn = (cmd: string[], opts?: any) => {
    if (!mockActive) return real.spawn(cmd as any, opts);
    const code = spawnExitQueue.length ? spawnExitQueue.shift()! : 0;
    spawnCalls.push([...cmd]);
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
  if (real.mawHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = real.mawHome;
  if (real.mawDataDir === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = real.mawDataDir;
  if (real.mawXdg === undefined) delete process.env.MAW_XDG;
  else process.env.MAW_XDG = real.mawXdg;
  if (tempRoot && _fs.existsSync(tempRoot)) _fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("cmd-update seventh-pass focused branch coverage", () => {
  test("heals a broken user plugin symlink when a bundled replacement exists", async () => {
    const pluginDir = join(homeDir, ".maw", "plugins");
    const root = join(tempRoot, "bundled", "commands", "plugins");
    mkdirp(pluginDir);
    mkdirp(join(root, "healed-plugin"));
    _fs.writeFileSync(join(root, "healed-plugin", "index.ts"), "export {};\n");
    _fs.symlinkSync(join(homeDir, "missing", "healed-plugin"), join(pluginDir, "healed-plugin"));

    const { healBrokenPluginSymlinks } = await import("../../src/cli/cmd-update");
    const result = healBrokenPluginSymlinks(pluginDir, [root]);

    expect(result).toEqual({ healed: 1, pruned: 0 });
    expect(_fs.realpathSync(join(pluginDir, "healed-plugin"))).toBe(_fs.realpathSync(join(root, "healed-plugin")));
  });

  test("--help exits before version, lock, or install side effects", async () => {
    const res = await captureRun(["update", "--help"], { testMode: null });

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("usage: maw update [ref]");
    expect(res.stderr).toBe("");
    expect(spawnCalls).toEqual([]);
    expect(lockCalls).toBe(0);
    expect(execSyncCalls).toEqual([]);
  });

  test("unknown flag-looking args are rejected before channel or install work", async () => {
    const res = await captureRun(["update", "--yess"], { testMode: null });

    expect(res.code).toBe(1);
    expect(res.stderr).toContain('invalid ref "--yess"');
    expect(spawnCalls).toEqual([]);
    expect(execSyncCalls).toEqual([]);
  });

  test("alpha channel resolves to the highest matching tag and stops at test-mode boundary", async () => {
    gitLsRemoteOutput = [
      "aaa\trefs/tags/v26.5.16-alpha.9",
      "bbb\trefs/tags/v26.5.17-beta.99",
      "ccc\trefs/tags/not-a-release",
      "ddd\trefs/tags/v26.5.17-alpha.10",
      "eee\trefs/tags/v26.4.99-alpha.200",
    ].join("\n");

    const res = await captureRun(["update", "alpha", "--yes"]);

    expect(res.code).toBeUndefined();
    expect(res.stdout).toContain("alpha channel → v26.5.17-alpha.10");
    expect(res.stdout).toContain('[test-mode] ref "v26.5.17-alpha.10" accepted');
    expect(execSyncCalls.filter((cmd) => cmd.includes("git ls-remote"))).toHaveLength(1);
    expect(spawnCalls).toEqual([]);
  });

  test("channel shortcut with no matching tags exits with a channel-specific error", async () => {
    gitLsRemoteOutput = "aaa\trefs/tags/v26.5.17-beta.1\n";

    const res = await captureRun(["update", "alpha", "--yes"]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no alpha tags in Soul-Brews-Studio/maw-js");
    expect(spawnCalls).toEqual([]);
  });

  test("channel shortcut reports git ls-remote failures", async () => {
    gitLsRemoteThrows = new Error("network unavailable");

    const res = await captureRun(["update", "beta", "--yes"]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("failed to resolve beta channel: network unavailable");
    expect(spawnCalls).toEqual([]);
  });

  test("non-interactive runs without --yes stop before destructive install", async () => {
    const res = await captureRun(["update", "main"], { stdinIsTTY: false });

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("non-interactive environment");
    expect(spawnCalls).toEqual([]);
    expect(lockCalls).toBe(0);
  });

  test("invalid refs are rejected before the test-mode install guard", async () => {
    const res = await captureRun(["update", "bad;ref", "--yes"]);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain('invalid ref "bad;ref"');
    expect(res.stdout).not.toContain("[test-mode]");
    expect(spawnCalls).toEqual([]);
  });

  test("rollback path reports a failed STASH-to-BIN restore when fresh binary verification fails", async () => {
    prepareInstallHome();
    failRollbackBinRestore = true;
    spawnExitQueue = [1, 0, 1];

    const res = await captureRun(["update", "v26.5.16-alpha.1053", "--yes"], { testMode: null });

    expect(res.code).toBe(1);
    expect(spawnCalls).toEqual([
      ["bun", "add", "-g", "github:Soul-Brews-Studio/maw-js#v26.5.16-alpha.1053"],
      ["bun", "add", "-g", "github:Soul-Brews-Studio/maw-js#v26.5.16-alpha.1053"],
      ["maw", "--version"],
    ]);
    expect(res.stderr).toContain("fresh install did not run — rolling back to previous maw");
    expect(res.stderr).toContain("failed to restore stash: rollback bin restore blocked");
  });

  test("successful install links a matching local SDK clone and creates XDG package metadata", async () => {
    prepareInstallHome();
    prepareClone("26.5.16-alpha.1053");
    ghqFindReturn = cloneDir;
    spawnExitQueue = [0];

    const res = await captureRun(["update", "v26.5.16-alpha.1053", "--yes"], { testMode: null });

    expect(res.code).toBeUndefined();
    expect(lockCalls).toBe(1);
    expect(spawnCalls).toEqual([
      ["bun", "add", "-g", "github:Soul-Brews-Studio/maw-js#v26.5.16-alpha.1053"],
    ]);
    expect(execSyncCalls).toContain(`cd ${cloneDir} && bun link`);
    expect(execSyncCalls).toContain(`cd ${join(homeDir, ".maw", "oracle-plugins")} && bun link maw`);
    expect(_fs.readFileSync(join(homeDir, ".maw", "oracle-plugins", "package.json"), "utf-8")).toContain("oracle-plugins");
    expect(res.stdout).toContain("SDK linked (@maw/sdk)");
  });
});
