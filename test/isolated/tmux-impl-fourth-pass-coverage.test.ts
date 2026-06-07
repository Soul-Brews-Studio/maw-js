import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");
const mockHome = "/mock-home-fourth-pass";

type SpawnCall = { args: unknown[]; opts?: unknown };

let fleetEntries: any[] = [];
let ghqRepos: string[] = [];
let spawnCalls: SpawnCall[] = [];
let tmuxSessionsStdout = "";
let nextSpawnExitCode = 0;
let tty = false;
let ttyReadText = "";

mock.module("os", () => ({
  homedir: () => mockHome,
}));

mock.module("fs", () => ({
  existsSync: () => false,
  readdirSync: () => [],
  readFileSync: () => { throw new Error("unexpected readFileSync"); },
  openSync: () => 42,
  readSync: (_fd: number, buffer: Buffer) => {
    buffer.write(ttyReadText);
    return Buffer.byteLength(ttyReadText);
  },
  closeSync: () => undefined,
}));

mock.module(join(srcRoot, "src/sdk"), () => ({
  hostExec: async () => "",
  tmux: {
    listPanes: async () => [],
    capture: async () => "",
  },
  tmuxCmd: () => "tmux",
}));

mock.module(join(srcRoot, "src/commands/shared/fleet-load"), () => ({
  loadFleetEntries: () => fleetEntries,
}));

mock.module(join(srcRoot, "src/core/ghq"), () => ({
  ghqList: async () => ghqRepos,
  ghqListSync: () => ghqRepos,
}));

mock.module(join(srcRoot, "src/core/fleet/worktrees-scan"), () => ({
  scanWorktrees: async () => [],
}));

const impl = await import("../../src/commands/plugins/tmux/impl");
const { cmdTmuxAttach, similarOracleCandidatesFromRepos } = impl;

const original = {
  log: console.log,
  write: process.stdout.write,
  exit: process.exit,
  spawnSync: Bun.spawnSync,
  tmux: process.env.TMUX,
  tty: impl._tty.isStdoutTTY,
};

function spawnResult(stdout = "", exitCode = 0) {
  return {
    exitCode,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
    success: exitCode === 0,
  };
}

function installProcessExitThrow() {
  const exits: number[] = [];
  (process as any).exit = (code?: number) => {
    exits.push(code ?? 0);
    throw new Error(`process.exit:${code ?? 0}`);
  };
  return exits;
}

function captureLogs(fn: () => void) {
  const logs: string[] = [];
  const writes: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    console.log = original.log;
    process.stdout.write = original.write;
  }
  return { logs: logs.join("\n"), writes: writes.join("") };
}

beforeEach(() => {
  fleetEntries = [];
  ghqRepos = [];
  spawnCalls = [];
  tmuxSessionsStdout = "";
  nextSpawnExitCode = 0;
  tty = false;
  ttyReadText = "";
  delete process.env.TMUX;
  impl._tty.isStdoutTTY = () => tty;
  (Bun as any).spawnSync = (args: unknown[], opts?: unknown) => {
    if (Array.isArray(args) && args[0] === "tmux" && args[1] === "list-sessions") {
      return spawnResult(tmuxSessionsStdout, 0);
    }
    spawnCalls.push({ args, opts });
    return spawnResult("", nextSpawnExitCode);
  };
});

afterEach(() => {
  console.log = original.log;
  process.stdout.write = original.write;
  (process as any).exit = original.exit;
  (Bun as any).spawnSync = original.spawnSync;
  impl._tty.isStdoutTTY = original.tty;
  if (original.tmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = original.tmux;
});

describe("tmux impl fourth-pass recovery branch coverage", () => {
  test("attach auto-wakes a stale fleet-stem match and labels cloned fleet config candidates", () => {
    fleetEntries = [
      {
        file: "101-pulse.json",
        session: {
          windows: [{ name: "pulse-oracle", repo: "Soul-Brews-Studio/pulse-oracle" }],
        },
      },
    ];
    ghqRepos = ["/opt/Code/github.com/Soul-Brews-Studio/pulse-oracle"];
    nextSpawnExitCode = 7;
    const exits = installProcessExitThrow();

    const { logs } = captureLogs(() => {
      expect(() => cmdTmuxAttach("101-pulse")).toThrow("process.exit:7");
    });

    expect(logs).toContain("101-pulse matched but not running");
    expect(logs).toContain("pulse-oracle (cloned)");
    expect(logs).toContain("maw wake pulse -a");
    expect(spawnCalls).toEqual([
      { args: ["maw", "wake", "pulse", "-a"], opts: { stdio: ["inherit", "inherit", "inherit"] } },
    ]);
    expect(exits).toEqual([7]);
  });

  test("attach prints all ambiguous recovery candidates instead of auto-waking when non-interactive", () => {
    ghqRepos = [
      "/opt/Code/github.com/laris-co/pulse-oracle",
      "/opt/Code/github.com/Soul-Brews-Studio/pulse-oracle",
    ];
    const exits = installProcessExitThrow();

    const { logs } = captureLogs(() => {
      expect(() => cmdTmuxAttach("pulse")).toThrow("process.exit:1");
    });

    expect(logs).toContain("No session matches 'pulse'");
    expect(logs).toContain("laris-co/pulse-oracle");
    expect(logs).toContain("Soul-Brews-Studio/pulse-oracle");
    expect(logs).toContain("→ maw wake laris-co/pulse-oracle");
    expect(logs).toContain("→ maw wake Soul-Brews-Studio/pulse-oracle");
    expect(spawnCalls).toEqual([]);
    expect(exits).toEqual([1]);
  });

  test("attach renders a numbered prompt for ambiguous candidates in TTY mode", () => {
    tty = true;
    ghqRepos = [
      "/opt/Code/github.com/laris-co/pulse-oracle",
      "/opt/Code/github.com/Soul-Brews-Studio/pulse-oracle",
    ];
    const exits = installProcessExitThrow();

    const { logs, writes } = captureLogs(() => {
      expect(() => cmdTmuxAttach("pulse")).toThrow("process.exit:1");
    });

    expect(logs).toContain("Wake which oracle?");
    expect(logs).toContain("1");
    expect(logs).toContain("2");
    expect(logs).toContain("laris-co/pulse-oracle");
    expect(logs).toContain("Soul-Brews-Studio/pulse-oracle");
    expect(writes).toContain("Select [1-2]:");
    expect(spawnCalls).toEqual([]);
    expect(exits).toEqual([1]);
  });

  test("similar oracle candidates ignore non-oracles and de-duplicate identical repo slugs", () => {
    expect(similarOracleCandidatesFromRepos("pulse", [
      "/opt/Code/github.com/Soul-Brews-Studio/pulse-oracle",
      "/different/root/Soul-Brews-Studio/pulse-oracle",
      "/opt/Code/github.com/Soul-Brews-Studio/pulse-service",
      "/opt/Code/github.com/Soul-Brews-Studio/other-oracle",
    ])).toEqual(["Soul-Brews-Studio/pulse-oracle"]);
  });
});
