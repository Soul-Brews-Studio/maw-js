import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");

type Pane = { id: string; target: string; command?: string; title?: string; lastActivity?: number; source?: string; node?: string };

let hostCalls: string[] = [];
let paneCommand = "zsh\n";
let captureOutput = "pane output\n";
let panes: Pane[] = [];
let fleetFiles: string[] = [];
let ghqRepos: string[] = [];
let worktrees: unknown[] = [];

mock.module(join(srcRoot, "src/sdk"), () => ({
  FLEET_DIR: "/tmp/maw-test/fleet",
  CONFIG_DIR: "/tmp/maw-test/config",
  hostExec: async (cmd: string) => {
    hostCalls.push(cmd);
    if (cmd.includes("capture-pane")) return captureOutput;
    if (cmd.includes("pane_current_command")) return paneCommand;
    if (cmd.includes("display-message") && cmd.includes("session_name")) return "current-session\n";
    if (cmd.includes("list-sessions") && cmd.includes("session_created")) return "";
    return "";
  },
  listSessions: async () => [],
  readCache: () => ({ oracles: [], updated_at: "2026-05-17T00:00:00.000Z" }),
  scanAndCache: async () => ({ oracles: [], updated_at: "2026-05-17T00:00:00.000Z" }),
  isCacheStale: () => false,
  loadConfig: () => ({ agents: [], sessions: [] }),
  tmux: {
    listPanes: async () => panes,
    capture: async () => "",
  },
  tmuxCmd: () => "tmux",
}));

mock.module(join(srcRoot, "src/commands/shared/fleet-load"), () => ({
  loadFleetEntries: () => fleetFiles.map(file => ({ file })),
}));

mock.module(join(srcRoot, "src/core/ghq"), () => ({
  ghqList: async () => ghqRepos,
  ghqListSync: () => ghqRepos,
  ghqFind: async (suffix: string) => ghqRepos.find(repo => repo.endsWith(suffix)) ?? null,
  ghqFindSync: (suffix: string) => ghqRepos.find(repo => repo.endsWith(suffix)) ?? null,
}));

mock.module(join(srcRoot, "src/core/fleet/worktrees-scan"), () => ({
  scanWorktrees: async () => worktrees,
}));

const impl = await import("../../src/commands/plugins/tmux/impl");
const {
  _sendTracker,
  cmdTmuxKill,
  cmdTmuxLayout,
  cmdTmuxLs,
  cmdTmuxPeek,
  cmdTmuxSend,
  cmdTmuxSplit,
} = impl;

async function captureLogs(fn: () => void | Promise<void>) {
  const logs: string[] = [];
  const warnings: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  return { logs: logs.join("\n"), warnings: warnings.join("\n") };
}

beforeEach(() => {
  hostCalls = [];
  paneCommand = "zsh\n";
  captureOutput = "pane output\n";
  panes = [];
  fleetFiles = [];
  ghqRepos = [];
  worktrees = [];
  _sendTracker.clear();
});

describe("cmdTmuxPeek — mocked tmux side effects", () => {
  test("captures default tail lines for pane id targets and prints resolution", async () => {
    const { logs } = await captureLogs(() => cmdTmuxPeek("%321"));
    expect(hostCalls).toEqual(["tmux capture-pane -pt '%321' -S -30 -J"]);
    expect(logs).toContain("%321 → %321 [pane-id]");
    expect(logs).toContain("pane output");
  });

  test("history mode captures full scrollback instead of bounded tail", async () => {
    await captureLogs(() => cmdTmuxPeek("%321", { lines: 7, history: true }));
    expect(hostCalls).toEqual(["tmux capture-pane -pt '%321' -S - -J"]);
  });
});

describe("cmdTmuxSend — mocked safety gates and send command", () => {
  test("checks pane command, sends Enter by default, and records success", async () => {
    const { logs } = await captureLogs(() => cmdTmuxSend("%321", "echo hello"));
    expect(hostCalls).toEqual([
      "tmux display-message -p -t '%321' '#{pane_current_command}'",
      "tmux send-keys -t '%321' 'echo hello' Enter",
    ]);
    expect(logs).toContain("sent to %321 → %321");
  });

  test("literal mode omits Enter and shell-quotes single quotes", async () => {
    await captureLogs(() => cmdTmuxSend("%321", "echo 'hi'", { literal: true }));
    expect(hostCalls.at(-1)).toBe("tmux send-keys -t '%321' 'echo '\\''hi'\\'''");
  });

  test("refuses claude-like panes before sending keys unless forced", async () => {
    paneCommand = "claude\n";
    await expect(cmdTmuxSend("%321", "echo unsafe")).rejects.toThrow(/refusing to send: pane '%321' is running 'claude'/);
    expect(hostCalls).toEqual(["tmux display-message -p -t '%321' '#{pane_current_command}'"]);
  });

  test("force bypasses cooldown and claude-pane refusal", async () => {
    paneCommand = "claude\n";
    _sendTracker.set("%321", { lastTs: Date.now(), count: 100, windowStart: Date.now() });
    await captureLogs(() => cmdTmuxSend("%321", "echo forced", { force: true }));
    expect(hostCalls).toEqual([
      "tmux display-message -p -t '%321' '#{pane_current_command}'",
      "tmux send-keys -t '%321' 'echo forced' Enter",
    ]);
  });

  test("cooldown throttles repeated sends before pane lookup", async () => {
    await captureLogs(() => cmdTmuxSend("%321", "echo first"));
    hostCalls = [];

    const { warnings } = await captureLogs(() => cmdTmuxSend("%321", "echo second"));

    expect(warnings).toContain("send throttled");
    expect(hostCalls).toEqual([]);
  });
});

describe("cmdTmuxSplit/Layout/Kill — mocked tmux commands", () => {
  test("split builds vertical percent command with an optional shell command", async () => {
    await captureLogs(() => cmdTmuxSplit("%321", { vertical: true, pct: 33, cmd: "pwd" }));
    expect(hostCalls).toEqual(["tmux split-window -v -l 33% -t '%321' 'pwd'"]);
  });

  test("layout strips pane index and targets the tmux window", async () => {
    await captureLogs(() => cmdTmuxLayout("demo:2.3", "tiled"));
    expect(hostCalls).toEqual(["tmux select-layout -t 'demo:2' tiled"]);
  });

  test("kill refuses fleet sessions without force before hostExec kill", async () => {
    fleetFiles = ["101-mawjs.json"];

    await expect(cmdTmuxKill("101-mawjs:0.1")).rejects.toThrow(/refusing to kill: session '101-mawjs'/);
    expect(hostCalls).toEqual([]);
  });

  test("forced session kill targets the resolved session name", async () => {
    fleetFiles = ["101-mawjs.json"];

    await captureLogs(() => cmdTmuxKill("101-mawjs:0.1", { session: true, force: true }));

    expect(hostCalls).toEqual(["tmux kill-session -t '101-mawjs'"]);
  });
});

describe("cmdTmuxLs — mocked pane listing", () => {
  test("json mode emits annotated panes without real tmux", async () => {
    const now = Math.floor(Date.now() / 1000);
    fleetFiles = ["101-mawjs.json"];
    panes = [
      { id: "%1", target: "101-mawjs:0.0", command: "claude", title: "fleet", lastActivity: now },
      { id: "%2", target: "scratch:0.0", command: "zsh", title: "shell", lastActivity: now - 60 },
    ];

    const { logs } = await captureLogs(() => cmdTmuxLs({ all: true, json: true }));
    const parsed = JSON.parse(logs);
    expect(parsed).toMatchObject([
      { id: "%1", session: "101-mawjs", annotation: "fleet: mawjs", status: "active" },
      { id: "%2", session: "scratch", annotation: "", status: "idle" },
    ]);
    expect(hostCalls.filter(cmd => cmd.includes("display-message"))).toEqual(process.env.TMUX ? ["tmux display-message -p '#{session_name}'"] : []);
  });

  test("filters channel helper sessions by default and supports node/query filtering", async () => {
    const now = Math.floor(Date.now() / 1000);
    panes = [
      { id: "%1", target: "23-discord-admin:0.0", command: "claude", title: "discord", lastActivity: now },
      { id: "%2", target: "mawjs-oracle-discord:0.0", command: "claude", title: "channel", lastActivity: now, source: "m5" },
      { id: "%3", target: "odin-discord:0.0", command: "claude", title: "channel", lastActivity: now, source: "m5" },
      { id: "%4", target: "alpha-worker:0.0", command: "node", title: "worker", lastActivity: now, source: "alpha" },
      { id: "%5", target: "homekeeper:0.0", command: "node", title: "mentions alpha but is not alpha", lastActivity: now, source: "m5" },
      { id: "%6", target: "50-discord:0.0", command: "claude", title: "numbered channel", lastActivity: now, source: "m5" },
    ];

    let out = await captureLogs(() => cmdTmuxLs({ all: true, json: true }));
    expect(JSON.parse(out.logs).map((pane: { session: string }) => pane.session)).toEqual([
      "23-discord-admin",
      "alpha-worker",
      "homekeeper",
    ]);

    out = await captureLogs(() => cmdTmuxLs({ all: true, json: true, channels: true }));
    expect(JSON.parse(out.logs).map((pane: { session: string }) => pane.session)).toEqual([
      "23-discord-admin",
      "mawjs-oracle-discord",
      "odin-discord",
      "alpha-worker",
      "homekeeper",
      "50-discord",
    ]);

    out = await captureLogs(() => cmdTmuxLs({ all: true, json: true, filter: "alpha" }));
    expect(JSON.parse(out.logs).map((pane: { session: string }) => pane.session)).toEqual(["alpha-worker"]);
  });

  test("compact oracle ls hides non-fleet junk sessions by default and --all roster shows them", async () => {
    const now = Math.floor(Date.now() / 1000);
    fleetFiles = ["50-mawjs.json"];
    panes = [
      { id: "%1", target: "50-mawjs:0.0", command: "claude", title: "fleet", lastActivity: now },
      { id: "%2", target: "--help:0.0", command: "zsh", title: "junk", lastActivity: now - 999 },
      { id: "%3", target: "foo:0.0", command: "zsh", title: "test", lastActivity: now - 999 },
      { id: "%4", target: "52---help:0.0", command: "zsh", title: "option artifact", lastActivity: now - 999 },
    ];

    let out = await captureLogs(() => cmdTmuxLs({ all: true, compact: true, oracleOnly: true }));
    expect(out.logs).toContain("50-mawjs");
    expect(out.logs).not.toContain("--help");
    expect(out.logs).not.toContain("foo");
    expect(out.logs).not.toContain("52---help");

    out = await captureLogs(() => cmdTmuxLs({ all: true, compact: true, roster: true }));
    expect(out.logs).toContain("50-mawjs");
    expect(out.logs).toContain("--help");
    expect(out.logs).toContain("foo");
    expect(out.logs).toContain("52---help");
  });

});
