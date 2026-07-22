import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");

let paneCommands: Map<string, string>;
let sessions: Array<{ name: string; windows: Array<{ index: number; name: string }> }>;
let teamMembers: string[];
let fleetEntries: Array<{ groupName: string; file: string; session: { name: string } }>;
let sendCalls: Array<{ target: string; text: string }>;

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  loadConfig: () => ({ namedPeers: [], peers: [] }),
  cfgTimeout: () => 1000,
  curlFetch: async () => ({ ok: true, data: { enabled: false } }),
  isAgentCommand: (cmd: string | null | undefined) => ["claude", "codex", "node"].includes(String(cmd ?? "").trim()),
  loadOracleRegistry: (teamName: string) => teamMembers.length
    ? { name: teamName, members: teamMembers.map(oracle => ({ oracle, role: "member", addedAt: "2026-06-06T00:00:00.000Z" })), createdAt: "2026-06-06T00:00:00.000Z" }
    : null,
  loadFleetEntries: () => fleetEntries,
  tmux: {
    run: async (subcommand: string, ...args: string[]) => {
      if (subcommand !== "display-message") return "";
      if (args[0] === "-p" && args[1] === "#{window_name}") return "sender\n";
      const targetIndex = args.indexOf("-t");
      if (targetIndex >= 0) return `${paneCommands.get(args[targetIndex + 1]!) ?? "zsh"}\n`;
      return "";
    },
    listAll: async () => sessions,
    sendText: async (target: string, text: string) => { sendCalls.push({ target, text }); },
  },
}));

const { default: broadcastHandler } = await import("../../src/vendor/mpr-plugins/broadcast/index.ts?plugin-broadcast-standalone");
const { parseBroadcastArgs, fleetScopeSessionNames } = await import("../../src/vendor/mpr-plugins/broadcast/impl.ts?plugin-broadcast-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  paneCommands = new Map();
  sessions = [];
  teamMembers = [];
  fleetEntries = [];
  sendCalls = [];
});

describe("broadcast plugin standalone boundary (#2113)", () => {
  test("imports plugin contracts and runtime helpers only through the SDK boundary", () => {
    const index = readFileSync(join(root, "src/vendor/mpr-plugins/broadcast/index.ts"), "utf8");
    const impl = readFileSync(join(root, "src/vendor/mpr-plugins/broadcast/impl.ts"), "utf8");
    for (const source of [index, impl]) {
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|lib|plugin)(?:\/|\")/);
      expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
    }
    expect(index).toContain('from "maw-js/sdk"');
    expect(impl).toContain('from "maw-js/sdk"');
  });

  test("parses scopes and broadcasts only to agent panes", async () => {
    expect(parseBroadcastArgs(["--session", "77-mawjs", "hello", "team"])).toEqual({
      message: "hello team",
      scope: { session: "77-mawjs" },
      verbose: false, // kobo-368 — compact-ack sweep default
    });
    sessions = [{ name: "77-mawjs", windows: [{ index: 0, name: "agent" }, { index: 1, name: "shell" }] }];
    paneCommands.set("77-mawjs:0", "codex");
    paneCommands.set("77-mawjs:1", "zsh");

    const result = await broadcastHandler({ source: "cli", args: ["--session", "77-mawjs", "hello", "team"] } as any);

    expect(result.ok).toBe(true);
    expect(sendCalls).toEqual([{ target: "77-mawjs:0", text: "[broadcast from sender] hello team" }]);
    expect(stripAnsi(result.output)).toContain("Broadcast to 1 windows (1 skipped) [scope: session=77-mawjs]");
  });

  test("fleet scope resolves through SDK fleet entries", () => {
    fleetEntries = [{ groupName: "mawjs", file: "077-mawjs.json", session: { name: "77-mawjs" } }];

    expect([...fleetScopeSessionNames("mawjs")]).toEqual(["77-mawjs"]);
    expect([...fleetScopeSessionNames("mawjs-oracle")]).toEqual(["77-mawjs"]);
  });

  // kobo-368 compact-ack sweep
  describe("compact-ack sweep (kobo-368)", () => {
    test("default (no --verbose/--full) → per-window 'sent →' lines suppressed, summary stays", async () => {
      expect(parseBroadcastArgs(["--session", "77-mawjs", "hello"])).toEqual({
        message: "hello", scope: { session: "77-mawjs" }, verbose: false,
      });
      sessions = [{ name: "77-mawjs", windows: [{ index: 0, name: "agent" }] }];
      paneCommands.set("77-mawjs:0", "codex");

      const result = await broadcastHandler({ source: "cli", args: ["--session", "77-mawjs", "hello"] } as any);
      expect(result.ok).toBe(true);
      expect(sendCalls).toEqual([{ target: "77-mawjs:0", text: "[broadcast from sender] hello" }]); // still sent
      expect(stripAnsi(result.output)).not.toContain("sent → 77-mawjs:agent"); // per-window echo suppressed
      expect(stripAnsi(result.output)).toContain("Broadcast to 1 windows"); // summary stays (was already compact)
    });

    test("--verbose/--full reproduce the pre-368 per-window echo (regression pin, byte-equiv)", async () => {
      expect(parseBroadcastArgs(["--session", "77-mawjs", "hello", "--verbose"])).toEqual({
        message: "hello", scope: { session: "77-mawjs" }, verbose: true,
      });
      expect(parseBroadcastArgs(["--session", "77-mawjs", "hello", "--full"])).toEqual({
        message: "hello", scope: { session: "77-mawjs" }, verbose: true,
      });
      sessions = [{ name: "77-mawjs", windows: [{ index: 0, name: "agent" }] }];
      paneCommands.set("77-mawjs:0", "codex");

      const result = await broadcastHandler({ source: "cli", args: ["--session", "77-mawjs", "hello", "--verbose"] } as any);
      expect(result.ok).toBe(true);
      expect(stripAnsi(result.output)).toContain("sent → 77-mawjs:agent");
      expect(stripAnsi(result.output)).toContain("Broadcast to 1 windows");
    });
  });
});
