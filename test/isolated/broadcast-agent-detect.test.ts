/**
 * #1881 — broadcast must use isAgentCommand (not hardcoded "claude" substring)
 * so panes running thclaws / codex / configured engines are reached.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "path";

let paneCommands = new Map<string, string>();
let sessions: Array<{ name: string; windows: Array<{ index: number; name: string }> }> = [];
let teamMembers: string[] = [];
let fleetEntries: Array<{ groupName: string; file: string; session: { name: string } }> = [];
let sendCalls: Array<{ target: string; text: string }> = [];
let logs: string[] = [];
let originalLog: typeof console.log;

mock.module("maw-js/sdk", () => ({
  hostExec: async () => "",
  listSessions: async () => [],
  tmuxCmd: () => "tmux",
  isAgentCommand: (cmd: string | null | undefined) => /claude|codex|thclaws|thclaude/i.test((cmd ?? "").trim()) || /^node$/i.test((cmd ?? "").trim()) || /^\d+\.\d+\.\d+$/.test((cmd ?? "").trim()),
  loadOracleRegistry: (teamName: string) => teamMembers.length
    ? { name: teamName, members: teamMembers.map(oracle => ({ oracle, role: "member", addedAt: "2026-06-06T00:00:00.000Z" })), createdAt: "2026-06-06T00:00:00.000Z" }
    : null,
  loadFleetEntries: () => fleetEntries,
  tmux: {
    run: async (subcommand: string, ...args: string[]) => {
      if (subcommand === "display-message") {
        if (args.length === 2 && args[0] === "-p" && args[1] === "#{window_name}") {
          return "sender-pane\n";
        }
        if (args.includes("-t")) {
          const target = args[args.indexOf("-t") + 1]!;
          return (paneCommands.get(target) ?? "zsh") + "\n";
        }
      }
      return "";
    },
    listAll: async () => sessions,
    sendText: async (target: string, text: string) => {
      sendCalls.push({ target, text });
    },
  },
}));


const { cmdBroadcast, parseBroadcastArgs } = await import("../../src/vendor/mpr-plugins/broadcast/impl");

beforeEach(() => {
  paneCommands = new Map();
  sessions = [
    {
      name: "77-mawjs",
      windows: [
        { index: 0, name: "claude-pane" },
        { index: 1, name: "thclaws-pane" },
        { index: 2, name: "zsh-pane" },
      ],
    },
  ];
  teamMembers = [];
  fleetEntries = [];
  sendCalls = [];
  logs = [];
  originalLog = console.log;
  console.log = (...args: any[]) => logs.push(args.map(String).join(" "));

});

afterEach(() => {
  console.log = originalLog;
});

test("parses scope flags and preserves unquoted message", () => {
  expect(parseBroadcastArgs(["--session", "77-mawjs", "--team", "builders", "--fleet", "mawjs", "hello", "team"])).toEqual({
    message: "hello team",
    scope: { session: "77-mawjs", team: "builders", fleet: "mawjs" },
    verbose: false, // kobo-368 — compact-ack sweep default
  });
});

test("--session limits broadcast to panes in that session", async () => {
  sessions = [
    { name: "77-mawjs", windows: [{ index: 0, name: "neo" }] },
    { name: "88-other", windows: [{ index: 0, name: "trinity" }] },
  ];
  paneCommands.set("77-mawjs:0", "claude");
  paneCommands.set("88-other:0", "claude");

  await cmdBroadcast("hello", { session: "77-mawjs" });
  console.log = originalLog;

  expect(sendCalls.map(c => c.target)).toEqual(["77-mawjs:0"]);
  expect(logs.some(l => l.includes("scope: session=77-mawjs"))).toBe(true);
});

test("--team limits broadcast to charter/member windows", async () => {
  sessions = [
    { name: "77-mawjs", windows: [{ index: 0, name: "builder" }, { index: 1, name: "reviewer-oracle" }, { index: 2, name: "bystander" }] },
  ];
  teamMembers = ["builder-oracle", "reviewer"];
  paneCommands.set("77-mawjs:0", "claude");
  paneCommands.set("77-mawjs:1", "codex");
  paneCommands.set("77-mawjs:2", "claude");

  await cmdBroadcast("standup", { team: "alpha" });
  console.log = originalLog;

  expect(sendCalls.map(c => c.target)).toEqual(["77-mawjs:0", "77-mawjs:1"]);
  expect(logs.some(l => l.includes("scope: team=alpha"))).toBe(true);
});

test("--fleet limits broadcast to fleet-tagged session", async () => {
  sessions = [
    { name: "01-neo", windows: [{ index: 0, name: "neo" }] },
    { name: "02-trinity", windows: [{ index: 0, name: "trinity" }] },
  ];
  fleetEntries = [{ groupName: "neo", file: "01-neo.json", session: { name: "01-neo" } }];
  paneCommands.set("01-neo:0", "claude");
  paneCommands.set("02-trinity:0", "claude");

  await cmdBroadcast("ping", { fleet: "neo" });
  console.log = originalLog;

  expect(sendCalls.map(c => c.target)).toEqual(["01-neo:0"]);
  expect(logs.some(l => l.includes("scope: fleet=neo"))).toBe(true);
});

describe("broadcast agent detection (#1881)", () => {
  test("reaches claude panes (regression)", async () => {
    paneCommands.set("77-mawjs:0", "claude");
    paneCommands.set("77-mawjs:1", "claude");
    paneCommands.set("77-mawjs:2", "zsh");

    await cmdBroadcast("hello");
    console.log = originalLog;

    expect(sendCalls.map(c => c.target)).toEqual(["77-mawjs:0", "77-mawjs:1"]);
    expect(logs.some(l => l.includes("Broadcast to 2 windows (1 skipped)"))).toBe(true);
  });

  test("reaches thclaws panes (#1906 + #1881 fix)", async () => {
    paneCommands.set("77-mawjs:0", "thclaws");
    paneCommands.set("77-mawjs:1", "thclaude");
    paneCommands.set("77-mawjs:2", "zsh");

    await cmdBroadcast("hello");
    console.log = originalLog;

    // Before fix: 0 sent, 3 skipped (all hardcoded "claude" includes failed)
    // After fix:  2 sent (thclaws + thclaude), 1 skipped (zsh)
    expect(sendCalls.map(c => c.target)).toEqual(["77-mawjs:0", "77-mawjs:1"]);
    expect(logs.some(l => l.includes("Broadcast to 2 windows (1 skipped)"))).toBe(true);
  });

  test("emits verbose skip-reason breakdown (#1881 Q2)", async () => {
    paneCommands.set("77-mawjs:0", "claude");
    paneCommands.set("77-mawjs:1", "zsh");
    paneCommands.set("77-mawjs:2", "bash");

    await cmdBroadcast("hi");
    console.log = originalLog;

    const breakdown = logs.find(l => l.includes("skipped breakdown:"));
    expect(breakdown).toBeDefined();
    expect(logs.some(l => /non-agent-pane: 2/.test(l))).toBe(true);
  });

  test("no breakdown printed when nothing was skipped", async () => {
    paneCommands.set("77-mawjs:0", "claude");
    paneCommands.set("77-mawjs:1", "claude");
    paneCommands.set("77-mawjs:2", "claude");

    await cmdBroadcast("hi");
    console.log = originalLog;

    expect(logs.some(l => l.includes("skipped breakdown:"))).toBe(false);
  });
});
