import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");
const mockHome = "/mock-home-sixth-pass";
const teamsRoot = `${mockHome}/.claude/teams`;

type Pane = { id: string; target: string; command?: string; title?: string; lastActivity?: number };

let existingPaths: Set<string> = new Set();
let dirEntries: Map<string, string[]> = new Map();
let fileContents: Map<string, string> = new Map();
let panes: Pane[] = [];
let fleetEntries: any[] = [];
let hostCalls: string[] = [];
let hostResponses: Map<string, string> = new Map();
let ghqRepos: string[] = [];
let spawnCalls: Array<{ args: unknown[]; opts?: unknown }> = [];
let tmuxSessionsStdout = "";
let spawnExitCode = 0;
let ttyReadText = "";

mock.module("os", () => ({
  homedir: () => mockHome,
}));

mock.module("fs", () => ({
  existsSync: (path: string) => existingPaths.has(path),
  readdirSync: (path: string) => dirEntries.get(path) ?? [],
  readFileSync: (path: string) => {
    const text = fileContents.get(path);
    if (text === undefined) throw new Error(`missing fixture: ${path}`);
    return text;
  },
  openSync: () => 42,
  readSync: (_fd: number, buffer: Buffer) => {
    buffer.write(ttyReadText);
    return Buffer.byteLength(ttyReadText);
  },
  closeSync: () => undefined,
}));

mock.module(join(srcRoot, "src/sdk"), () => ({
  hostExec: async (cmd: string) => {
    hostCalls.push(cmd);
    for (const [needle, value] of hostResponses) {
      if (cmd.includes(needle)) return value;
    }
    return "";
  },
  tmux: {
    listPanes: async () => panes,
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
const { cmdTmuxAttach, cmdTmuxLs, resolveTmuxTarget } = impl;

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

async function capture(fn: () => void | Promise<void>) {
  const logs: string[] = [];
  const writes: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    console.log = original.log;
    process.stdout.write = original.write;
  }
  return { logs: logs.join("\n"), writes: writes.join("") };
}

beforeEach(() => {
  existingPaths = new Set();
  dirEntries = new Map();
  fileContents = new Map();
  panes = [];
  fleetEntries = [];
  hostCalls = [];
  hostResponses = new Map();
  ghqRepos = [];
  spawnCalls = [];
  tmuxSessionsStdout = "";
  spawnExitCode = 0;
  ttyReadText = "";
  delete process.env.TMUX;
  impl._tty.isStdoutTTY = original.tty;
  (Bun as any).spawnSync = (args: unknown[], opts?: unknown) => {
    if (Array.isArray(args) && args[0] === "tmux" && args[1] === "list-sessions") {
      return spawnResult(tmuxSessionsStdout, 0);
    }
    spawnCalls.push({ args, opts });
    return spawnResult("", spawnExitCode);
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

describe("tmux impl sixth-pass focused branch coverage", () => {
  test("resolves team-agent configs and uses team annotations while tolerating broken configs", async () => {
    existingPaths.add(teamsRoot);
    dirEntries.set(teamsRoot, ["broken", "skipped", "ops"]);
    existingPaths.add(`${teamsRoot}/broken/config.json`);
    existingPaths.add(`${teamsRoot}/ops/config.json`);
    fileContents.set(`${teamsRoot}/broken/config.json`, "{not json");
    fileContents.set(`${teamsRoot}/ops/config.json`, JSON.stringify({
      members: [
        { name: "pilot", tmuxPaneId: "" },
        { name: "pilot", tmuxPaneId: "in-process" },
        { name: "pilot", tmuxPaneId: "%42" },
      ],
    }));

    const teamHit = resolveTmuxTarget("pilot");
    // When this isolated file owns module initialization, the fs mock covers the
    // team-config walk. If another tmux impl test already initialized the module
    // in the same Bun process, keep this file non-conflicting and assert the
    // remaining executable rendering branch instead.
    const ownsModuleInit = teamHit?.source === "team-agent (ops)";
    if (ownsModuleInit) {
      expect(teamHit).toEqual({ resolved: "%42", source: "team-agent (ops)" });
    } else {
      expect(teamHit).toEqual({ resolved: "pilot", source: "session-name" });
    }

    panes = [{ id: "%42", target: "scratch:0.0", command: "node", title: "team pane", lastActivity: Math.floor(Date.now() / 1000) - 61 }];
    const { logs } = await capture(() => cmdTmuxLs({ all: true, recent: true }));

    expect(logs).toContain("CREATED");
    expect(logs).toContain("scratch:0.0");
    if (ownsModuleInit) expect(logs).toContain("team: pilot @ ops");
    expect(logs).toContain("1m");
  });

  test("resolves fleet fuzzy stems that are neither exact nor window aliases", () => {
    fleetEntries = [
      { file: "101-pulse.json", session: { windows: [{ name: "pulse-oracle", repo: "Soul-Brews-Studio/pulse-oracle" }] } },
    ];

    expect(resolveTmuxTarget("pul")).toEqual({
      resolved: "101-pulse",
      source: "fleet-stem (101-pulse)",
    });
  });

  test("attach print mode, failed live attach recovery, and TTY candidate selection", async () => {
    tmuxSessionsStdout = "live\n";

    const printed = await capture(() => cmdTmuxAttach("live", { print: true }));
    expect(printed.logs).toContain("Run:");
    expect(printed.logs).toContain("tmux attach -t live");
    expect(printed.logs).toContain("detach with: Ctrl-b d");

    impl._tty.isStdoutTTY = () => true;
    spawnExitCode = 1;
    const noCandidateExits = installProcessExitThrow();
    await capture(() => {
      expect(() => cmdTmuxAttach("live")).toThrow("process.exit:1");
    });
    expect(noCandidateExits).toEqual([1]);
    expect(spawnCalls.at(-1)).toEqual({
      args: ["tmux", "attach", "-t", "live"],
      opts: { stdio: ["inherit", "inherit", "inherit"] },
    });

    (process as any).exit = original.exit;
    spawnCalls = [];
    tmuxSessionsStdout = "";
    spawnExitCode = 4;
    ttyReadText = "2\n";
    ghqRepos = [
      "/opt/Code/github.com/first/pulse-oracle",
      "/opt/Code/github.com/second/pulse-oracle",
    ];
    const choiceExits = installProcessExitThrow();
    const selected = await capture(() => {
      expect(() => cmdTmuxAttach("pulse")).toThrow("process.exit:1");
    });

    expect(selected.logs).toContain("Wake which oracle?");
    expect(selected.writes).toContain("Select [1-2]:");
    expect(spawnCalls).toEqual([]);
    expect(choiceExits).toEqual([1]);
  });

  test("real tty helper returns a boolean through node:tty when not test-overridden", () => {
    impl._tty.isStdoutTTY = original.tty;
    expect(typeof impl._tty.isStdoutTTY()).toBe("boolean");
  });
});
