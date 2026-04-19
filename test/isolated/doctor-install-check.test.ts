/**
 * maw doctor — install check (#531).
 *
 * Verifies cmdDoctor's install probe at src/commands/plugins/doctor/impl.ts:
 *   - binary present + symlink resolves → ok
 *   - binary present + dangling symlink → broken-symlink failure
 *   - binary present + readlink throws (not a symlink) → ok (treated as fine)
 *   - binary missing → execSync `bun add -g …` reinstall, then re-check
 *       · success + binary now present → ok, "reinstalled"
 *       · success + still missing      → fail, "did not produce"
 *       · execSync throws              → fail, "reinstall failed:"
 *   - args dispatch: [] / ["all"] / ["install"] all run install; ["nonsense"]
 *     runs none (ok=true with empty checks).
 *
 * Isolated because we mock.module on `fs` (existsSync/readlinkSync) and
 * `child_process` (execSync). Capture real refs before installing mocks per
 * the #429 / fleet-doctor.test.ts pattern so passthrough doesn't loop.
 *
 * Console output is silenced inside `run()` — the impl prints status lines
 * for the missing-binary branch which would otherwise pollute test stdout.
 */

import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { homedir } from "os";
import { join } from "path";

// ─── Gate ───────────────────────────────────────────────────────────────────

let mockActive = false;

// ─── Capture real module refs BEFORE any mock.module installs ───────────────

const realFs = await import("fs");
const realChildProcess = await import("child_process");

// ─── Mutable state (reset per-test) ─────────────────────────────────────────

const BIN_PATH = join(homedir(), ".bun/bin/maw");
const EINVAL = (): Error => Object.assign(new Error("EINVAL: invalid argument, readlink"), { code: "EINVAL" });

let existsMap: Record<string, boolean> = {};
let readlinkBehavior: { kind: "return"; value: string } | { kind: "throw"; err: Error } =
  { kind: "throw", err: EINVAL() };

// execSync controls:
//   - throwError: if set, execSync throws this instead of returning
//   - flipBinaryToPresent: if true, side-effect sets existsMap[BIN_PATH]=true
let execSyncThrow: Error | null = null;
let execSyncFlipBinaryPresent = false;
let execSyncCalls: Array<{ cmd: string; opts: unknown }> = [];

// ─── Mocks ──────────────────────────────────────────────────────────────────

await mock.module("fs", () => ({
  ...realFs,
  existsSync: (p: string): boolean => {
    if (!mockActive) return realFs.existsSync(p);
    return !!existsMap[p];
  },
  readlinkSync: (p: string): string => {
    if (!mockActive) return realFs.readlinkSync(p) as string;
    if (readlinkBehavior.kind === "throw") throw readlinkBehavior.err;
    return readlinkBehavior.value;
  },
}));

await mock.module("child_process", () => ({
  ...realChildProcess,
  execSync: (cmd: string, opts?: unknown): Buffer | string => {
    if (!mockActive) return realChildProcess.execSync(cmd, opts as never);
    execSyncCalls.push({ cmd, opts });
    if (execSyncThrow) throw execSyncThrow;
    if (execSyncFlipBinaryPresent) existsMap[BIN_PATH] = true;
    return "";
  },
}));

// Import target AFTER mocks so its module graph resolves through our stubs.
const { cmdDoctor } = await import("../../src/commands/plugins/doctor/impl");

// ─── Console silencer ───────────────────────────────────────────────────────

const origLog = console.log;
async function run<T>(fn: () => Promise<T>): Promise<T> {
  console.log = () => {};
  try { return await fn(); }
  finally { console.log = origLog; }
}

beforeEach(() => {
  mockActive = true;
  existsMap = {};
  readlinkBehavior = { kind: "throw", err: EINVAL() };
  execSyncThrow = null;
  execSyncFlipBinaryPresent = false;
  execSyncCalls = [];
});

afterEach(() => { mockActive = false; });
afterAll(() => { mockActive = false; console.log = origLog; });

// ════════════════════════════════════════════════════════════════════════════
// install check — binary present branches
// ════════════════════════════════════════════════════════════════════════════

describe("cmdDoctor install — binary present", () => {
  test("symlink resolves → ok true, message 'present and resolvable'", async () => {
    const target = join(homedir(), ".bun/install/cache/maw");
    existsMap[BIN_PATH] = true;
    existsMap[target] = true;
    readlinkBehavior = { kind: "return", value: target };

    const out = await run(() => cmdDoctor([]));

    expect(out.ok).toBe(true);
    expect(out.checks.find(c => c.name === "install")).toBeDefined();
    const install = out.checks.find(c => c.name === "install")!;
    expect(install.ok).toBe(true);
    expect(install.message).toContain("present and resolvable");
    expect(execSyncCalls.filter(c => c.cmd.startsWith("bun add"))).toHaveLength(0);
  });

  test("relative symlink resolved against bin dir → ok true", async () => {
    const relTarget = "../install/cache/maw";
    const absTarget = join(homedir(), ".bun/install/cache/maw");
    existsMap[BIN_PATH] = true;
    existsMap[absTarget] = true;
    readlinkBehavior = { kind: "return", value: relTarget };

    const out = await run(() => cmdDoctor([]));

    expect(out.ok).toBe(true);
    expect(out.checks.find(c => c.name === "install")!.message).toContain("present and resolvable");
  });

  test("dangling symlink (link target missing) → ok false, message 'broken symlink'", async () => {
    const target = join(homedir(), ".bun/install/cache/gone");
    existsMap[BIN_PATH] = true;
    existsMap[target] = false;
    readlinkBehavior = { kind: "return", value: target };

    const out = await run(() => cmdDoctor([]));

    expect(out.ok).toBe(false);
    const install = out.checks.find(c => c.name === "install")!;
    expect(install.ok).toBe(false);
    expect(install.message).toContain("broken symlink");
    expect(install.message).toContain(target);
    expect(execSyncCalls.filter(c => c.cmd.startsWith("bun add"))).toHaveLength(0);
  });

  test("not a symlink (readlinkSync throws EINVAL) → ok true", async () => {
    existsMap[BIN_PATH] = true;
    readlinkBehavior = { kind: "throw", err: EINVAL() };

    const out = await run(() => cmdDoctor([]));

    expect(out.ok).toBe(true);
    const install = out.checks.find(c => c.name === "install")!;
    expect(install.ok).toBe(true);
    expect(install.message).toContain("present and resolvable");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// install check — binary missing → reinstall branches
// ════════════════════════════════════════════════════════════════════════════

describe("cmdDoctor install — binary missing → reinstall", () => {
  test("execSync succeeds + binary now present → ok true, message 'reinstalled'", async () => {
    existsMap[BIN_PATH] = false;
    execSyncFlipBinaryPresent = true; // side-effect: install creates the binary

    const out = await run(() => cmdDoctor(["install"]));

    expect(out.ok).toBe(true);
    const install = out.checks.find(c => c.name === "install")!;
    expect(install.ok).toBe(true);
    expect(install.message).toContain("reinstalled");
    expect(install.message).toContain("github:Soul-Brews-Studio/maw-js");
    const addCalls = execSyncCalls.filter(c => c.cmd.startsWith("bun add"));
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0].cmd).toContain("bun add -g");
    expect(addCalls[0].cmd).toContain("Soul-Brews-Studio/maw-js");
  });

  test("execSync succeeds + binary still missing → ok false, message 'did not produce'", async () => {
    existsMap[BIN_PATH] = false;
    execSyncFlipBinaryPresent = false; // install "succeeds" but binary doesn't appear

    const out = await run(() => cmdDoctor(["install"]));

    expect(out.ok).toBe(false);
    const install = out.checks.find(c => c.name === "install")!;
    expect(install.ok).toBe(false);
    expect(install.message).toContain("did not produce");
    expect(execSyncCalls.filter(c => c.cmd.startsWith("bun add"))).toHaveLength(1);
  });

  test("execSync throws → ok false, message starts with 'reinstall failed:'", async () => {
    existsMap[BIN_PATH] = false;
    execSyncThrow = new Error("network unreachable");

    const out = await run(() => cmdDoctor(["install"]));

    expect(out.ok).toBe(false);
    const install = out.checks.find(c => c.name === "install")!;
    expect(install.ok).toBe(false);
    expect(install.message).toMatch(/^reinstall failed:/);
    expect(install.message).toContain("network unreachable");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// args dispatch
// ════════════════════════════════════════════════════════════════════════════

describe("cmdDoctor args dispatch", () => {
  test("args=[] runs install + version checks", async () => {
    existsMap[BIN_PATH] = true;

    const out = await run(() => cmdDoctor([]));

    expect(out.checks.map(c => c.name)).toContain("install");
    expect(out.checks.some(c => c.name.startsWith("version:"))).toBe(true);
  });

  test("args=['all'] runs install + version checks", async () => {
    existsMap[BIN_PATH] = true;

    const out = await run(() => cmdDoctor(["all"]));

    expect(out.checks.map(c => c.name)).toContain("install");
    expect(out.checks.some(c => c.name.startsWith("version:"))).toBe(true);
  });

  test("args=['install'] runs install check only", async () => {
    existsMap[BIN_PATH] = true;

    const out = await run(() => cmdDoctor(["install"]));

    expect(out.checks.map(c => c.name)).toEqual(["install"]);
    expect(out.ok).toBe(true);
  });

  test("args=['nonsense'] runs no checks → ok true, empty checks", async () => {
    const out = await run(() => cmdDoctor(["nonsense"]));

    expect(out.checks).toEqual([]);
    expect(out.ok).toBe(true);
  });
});
