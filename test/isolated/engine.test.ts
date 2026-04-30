/**
 * Engine tests — ISOLATED SUITE.
 *
 * Why isolated: these tests need `mock.module("../../src/core/transport/ssh")`
 * to intercept hostExec → tmux commands. Bun's mock.module is process-global,
 * so putting this in the main test/ dir would pollute findWindow/tmux for
 * every other test file. This directory is excluded from `bun test test/` via
 * `--path-ignore-patterns` in package.json; it's exercised separately with
 * `bun test test/isolated/`.
 *
 * See: test/00-ssh.test.ts and src/core/runtime/find-window.ts for the
 * sister workaround used for findWindow.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";
import { mockSshModule } from "../helpers/mock-ssh";

// --- Shared test state (mutated per-test, read by mocks) ---

let sshResult = "";
let sshCommands: string[] = [];
let mockSessions: Array<{
  name: string;
  windows: { index: number; name: string; active: boolean }[];
}> = [];

// --- Mocks (must run before MawEngine import) ---

// Config — tmux.ts and many transport modules read from here at load time.
mock.module("../../src/config", () => mockConfigModule(() => ({ host: "local" })));

// ssh — tmux.ts imports hostExec from here; mocking it intercepts every
// tmux.run() call and lets us feed synthetic list-windows / list-panes output.
// Use mockSshModule so all 11 real exports are present — partial mocks pollute
// the bun process and break engine.ts's transitive imports (e.g. HostExecError
// pulled in via fleet-wake-failsoft).
mock.module("../../src/core/transport/ssh", () =>
  mockSshModule({
    hostExec: async (cmd: string) => {
      sshCommands.push(cmd);
      // tmux list-windows -a -F '#{session_name}|||#{window_index}|||#{window_name}|||#{window_active}|||#{pane_current_path}'
      if (cmd.includes("list-windows")) {
        return mockSessions
          .flatMap(s => s.windows.map(w =>
            `${s.name}|||${w.index}|||${w.name}|||${w.active ? "1" : "0"}|||/tmp`,
          ))
          .join("\n");
      }
      // tmux list-panes -a -F '#{session_name}:#{window_index}|||#{pane_current_command}'
      if (cmd.includes("list-panes")) {
        return mockSessions
          .flatMap(s => s.windows.map(w =>
            `${s.name}:${w.index}|||${sshResult || "zsh"}`,
          ))
          .join("\n");
      }
      if (cmd.includes("capture-pane")) return "captured";
      return "";
    },
    capture: async () => "captured",
    getPaneCommand: async () => sshResult || "zsh",
    getPaneCommands: async (targets: string[]) => {
      const out: Record<string, string> = {};
      for (const t of targets) out[t] = sshResult || "zsh";
      return out;
    },
    listSessions: async () => mockSessions,
  }),
);

// peers — no federation in tests; return local sessions unchanged.
mock.module("../../src/core/transport/peers", () => ({
  getPeers: () => [],
  getAggregatedSessions: async (local: any[]) => local,
  findPeerForTarget: async () => null,
  sendKeysToPeer: async () => false,
  getFederationStatus: async () => ({
    localUrl: "",
    peers: [],
    totalPeers: 0,
    reachablePeers: 0,
    clockHealth: { clockUtc: "", timezone: "", uptimeSeconds: 0 },
  }),
}));

// Import AFTER mocks so engine's transitive imports use the mocked modules.
const { MawEngine } = await import("../../src/engine");

// --- Helpers ---

/** Minimal WebSocket stub that records sent messages. */
function makeWS(): {
  ws: { data: { target: any; previewTargets: Set<string> }; send: (m: string) => void };
  messages: any[];
} {
  const messages: any[] = [];
  const ws = {
    data: { target: null, previewTargets: new Set<string>() },
    send: (msg: string) => {
      try { messages.push(JSON.parse(msg)); } catch { /* ignore non-JSON */ }
    },
  };
  return { ws, messages };
}

function newEngine() {
  return new MawEngine({ feedBuffer: [], feedListeners: new Set() });
}

// --- Tests ---

describe("MawEngine (isolated)", () => {
  beforeEach(() => {
    sshResult = "";
    sshCommands = [];
    mockSessions = [];
  });

  describe("handleOpen — no stale recent agents", () => {
    test("warm cache sends sessions instantly without recent message", async () => {
      mockSessions = [
        { name: "oracles", windows: [{ index: 1, name: "pulse-oracle", active: true }] },
      ];

      const engine = newEngine();
      // @ts-ignore — access private for testing
      engine.sessionCache = { sessions: mockSessions, json: "" };

      const { ws, messages } = makeWS();
      engine.handleOpen(ws as any);

      await new Promise(r => setTimeout(r, 200));

      const types = messages.map(m => m.type);
      expect(types).toContain("sessions");
      expect(types).toContain("feed-history");
      expect(types).not.toContain("recent"); // idle pane → no recent

      engine.handleClose(ws as any);
    });

    test("cold cache fetches via tmux.listAll, no recent message", async () => {
      mockSessions = [
        { name: "oracles", windows: [{ index: 1, name: "pulse-oracle", active: true }] },
        { name: "hermes", windows: [{ index: 1, name: "hermes-oracle", active: false }] },
      ];

      const engine = newEngine();
      // Wait briefly so initSessionCache populates (it runs in constructor).
      await new Promise(r => setTimeout(r, 50));

      // Clear commands captured by init; we only care what handleOpen triggers.
      sshCommands = [];

      const { ws, messages } = makeWS();
      engine.handleOpen(ws as any);

      await new Promise(r => setTimeout(r, 200));

      const types = messages.map(m => m.type);
      expect(types).toContain("sessions");
      expect(types).toContain("feed-history");
      expect(types).not.toContain("recent");

      engine.handleClose(ws as any);
    });
  });

  describe("handleOpen — sends recent for busy agents", () => {
    test("sends recent message when agents are running claude", async () => {
      sshResult = "claude";
      mockSessions = [
        { name: "oracles", windows: [{ index: 1, name: "pulse-oracle", active: true }] },
      ];

      const engine = newEngine();
      // @ts-ignore — access private for testing
      engine.sessionCache = { sessions: mockSessions, json: "" };

      const { ws, messages } = makeWS();
      engine.handleOpen(ws as any);

      await new Promise(r => setTimeout(r, 200));

      const recent = messages.find(m => m.type === "recent");
      expect(recent).toBeDefined();
      expect(recent!.agents).toHaveLength(1);
      expect(recent!.agents[0].target).toBe("oracles:1");
      expect(recent!.agents[0].name).toBe("pulse-oracle");
      expect(recent!.agents[0].session).toBe("oracles");

      engine.handleClose(ws as any);
    });

    test("no recent message when all agents are idle", async () => {
      sshResult = "zsh";
      mockSessions = [
        { name: "oracles", windows: [{ index: 1, name: "pulse-oracle", active: true }] },
      ];

      const engine = newEngine();
      // @ts-ignore — access private for testing
      engine.sessionCache = { sessions: mockSessions, json: "" };

      const { ws, messages } = makeWS();
      engine.handleOpen(ws as any);

      await new Promise(r => setTimeout(r, 200));

      const types = messages.map(m => m.type);
      expect(types).not.toContain("recent");

      engine.handleClose(ws as any);
    });
  });

  describe("broadcastSessions — no terminal scraping", () => {
    test("broadcasts sessions without recent message", async () => {
      mockSessions = [
        { name: "oracles", windows: [{ index: 1, name: "pulse-oracle", active: true }] },
      ];

      const engine = newEngine();
      const { ws, messages } = makeWS();
      engine.handleOpen(ws as any);
      await new Promise(r => setTimeout(r, 100));
      messages.length = 0; // clear initial messages
      sshCommands = [];

      // Trigger broadcast directly
      // @ts-ignore — access private for testing
      const { broadcastSessions } = await import("../../src/engine/capture");
      // @ts-ignore
      await broadcastSessions(engine.clients, engine.sessionCache, []);

      const types = messages.map(m => m.type);
      expect(types).not.toContain("recent");

      const captureCommands = sshCommands.filter(c => c.includes("capture-pane"));
      expect(captureCommands.length).toBe(0);

      engine.handleClose(ws as any);
    });

    test("uses single tmux list-windows -a command", async () => {
      mockSessions = [
        {
          name: "oracles",
          windows: [
            { index: 1, name: "pulse-oracle", active: true },
            { index: 2, name: "volt-oracle", active: false },
          ],
        },
      ];

      const engine = newEngine();
      // Let initSessionCache settle, then force the cold-fetch path so we
      // measure handleOpen's listAll call (not the constructor's).
      await new Promise(r => setTimeout(r, 50));
      // @ts-ignore — access private for testing
      engine.sessionCache = { sessions: [], json: "" };
      sshCommands = [];

      const { ws } = makeWS();
      engine.handleOpen(ws as any);

      await new Promise(r => setTimeout(r, 200));

      const listWindowsCmds = sshCommands.filter(c => c.includes("list-windows"));
      // Exactly one list-windows call (tmux.listAll) — not N per-session calls.
      expect(listWindowsCmds.length).toBe(1);
      expect(listWindowsCmds[0]).toContain("-a");

      engine.handleClose(ws as any);
    });
  });
});
