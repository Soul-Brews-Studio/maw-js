import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createRequire } from "module";
import { join } from "path";

const attachRoot = join(import.meta.dir, "../../src/vendor/mpr-plugins/attach");
const require = createRequire(import.meta.url);
const realFs = require("fs") as typeof import("fs");

let resolveResult: any = null;
let spawnCalls: string[][] = [];
let spawnExitCode = 0;
let tmuxAttachCalls: string[] = [];
let logs: string[] = [];
let errors: string[] = [];
let ttyWrites: string[] = [];
let ttyAnswer = "yes\n";
let ttyOpenThrows = false;

const original = {
  log: console.log,
  error: console.error,
  stderrWrite: process.stderr.write,
  spawn: Bun.spawn,
  stdinIsTTY: process.stdin.isTTY,
  fsOpenSync: realFs.openSync,
  fsReadSync: realFs.readSync,
  fsCloseSync: realFs.closeSync,
};

mock.module("maw-js/sdk", () => ({
  listSessions: async () => [],
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleet: () => [],
}));

mock.module(import.meta.resolve("../../src/commands/plugins/tmux/impl"), () => ({
  cmdTmuxAttach: (target: string) => {
    tmuxAttachCalls.push(target);
  },
}));

mock.module(join(attachRoot, "resolve-attach-target"), () => ({
  resolveAttachTarget: async () => resolveResult,
}));

const { cmdAttach } = await import("../../src/vendor/mpr-plugins/attach/impl.ts?vendor-attach-impl-next-coverage");

beforeEach(() => {
  resolveResult = null;
  spawnCalls = [];
  spawnExitCode = 0;
  tmuxAttachCalls = [];
  logs = [];
  errors = [];
  ttyWrites = [];
  ttyAnswer = "yes\n";
  ttyOpenThrows = false;

  console.log = ((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  }) as typeof console.log;
  console.error = ((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  }) as typeof console.error;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    ttyWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  realFs.openSync = (() => {
    if (ttyOpenThrows) throw new Error("no tty available");
    return 42;
  }) as typeof realFs.openSync;
  realFs.readSync = ((_fd: number, buffer: Buffer) => {
    const answer = Buffer.from(ttyAnswer);
    answer.copy(buffer);
    return answer.length;
  }) as typeof realFs.readSync;
  realFs.closeSync = (() => undefined) as typeof realFs.closeSync;
  Bun.spawn = ((cmd: string[], opts?: { stdin?: string; stdout?: string; stderr?: string }) => {
    spawnCalls.push([...cmd]);
    expect(opts).toMatchObject({ stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return { exited: Promise.resolve(spawnExitCode) } as ReturnType<typeof Bun.spawn>;
  }) as typeof Bun.spawn;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
});

afterEach(() => {
  console.log = original.log;
  console.error = original.error;
  process.stderr.write = original.stderrWrite;
  realFs.openSync = original.fsOpenSync;
  realFs.readSync = original.fsReadSync;
  realFs.closeSync = original.fsCloseSync;
  Bun.spawn = original.spawn;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: original.stdinIsTTY });
});

describe("attach impl interactive prompt coverage", () => {
  test("interactive Tier 2 accepts yes from /dev/tty before waking and attaching", async () => {
    resolveResult = { tier: 2, fleetName: "sleepy-oracle" };
    ttyAnswer = "yes\n";

    await cmdAttach("sleepy");

    expect(ttyWrites.join("")).toContain('Wake "sleepy-oracle"? [y/N]');
    expect(logs.join("\n")).toContain("'sleepy-oracle' is sleeping");
    expect(spawnCalls).toEqual([["maw", "wake", "sleepy-oracle"]]);
    expect(tmuxAttachCalls).toEqual(["sleepy-oracle"]);
  });

  test("interactive Tier 2 aborts cleanly when /dev/tty answer is not yes", async () => {
    resolveResult = { tier: 2, fleetName: "sleepy-oracle" };
    ttyAnswer = "no\n";

    await cmdAttach("sleepy");

    expect(ttyWrites.join("")).toContain('Wake "sleepy-oracle"? [y/N]');
    expect(logs.join("\n")).toContain("aborted — no changes made.");
    expect(spawnCalls).toEqual([]);
  });

  test("interactive Tier 2 defaults to no when /dev/tty cannot be opened", async () => {
    resolveResult = { tier: 2, fleetName: "ttyless-oracle" };
    ttyOpenThrows = true;

    await cmdAttach("ttyless");

    expect(logs.join("\n")).toContain("aborted — no changes made.");
    expect(ttyWrites).toEqual([]);
    expect(spawnCalls).toEqual([]);
  });

  test("interactive Tier 2 surfaces wake subprocess failures", async () => {
    resolveResult = { tier: 2, fleetName: "broken-oracle" };
    spawnExitCode = 9;

    await expect(cmdAttach("broken")).rejects.toThrow("maw wake broken-oracle exited 9");

    expect(spawnCalls).toEqual([["maw", "wake", "broken-oracle"]]);
    expect(errors).toEqual([]);
  });
});
