/**
 * mock-tmux.ts — reusable mocks for tmux + peers transport layers.
 *
 * Unblocks broadcastSessions / sendBusyAgents / federation tests that
 * need to control what `tmux.listAll()` and `getAggregatedSessions()`
 * return without touching the host tmux server.
 *
 * Usage:
 *
 *   import { describe, test, expect, afterEach, beforeEach } from "bun:test";
 *   import {
 *     installTmuxMock,
 *     installPeersMock,
 *     resetMocks,
 *     setPaneCommands,
 *     getCapturedCommands,
 *   } from "./helpers/mock-tmux";
 *
 *   describe("broadcastSessions", () => {
 *     beforeEach(() => {
 *       installTmuxMock({
 *         sessions: [
 *           { name: "oracles", windows: [{ index: 1, name: "pulse-oracle", active: true }] },
 *         ],
 *       });
 *       installPeersMock({ peers: [] });
 *       setPaneCommands({ "oracles:1": "claude" });
 *     });
 *     afterEach(() => resetMocks());
 *
 *     test("lists sessions", async () => {
 *       const { tmux } = await import("../../src/core/transport/tmux");
 *       expect(await tmux.listAll()).toHaveLength(1);
 *     });
 *   });
 *
 * Scope: mocks are installed lazily on first install*Mock() call (NOT at
 * import time). `resetMocks()` clears internal state so subsequent calls
 * see empty sessions / no peers. NB: bun's `mock.module()` is global —
 * once installed, the module-level shim stays in place for the rest of
 * the process. State isolation between tests comes from clearing
 * config inside resetMocks(), not from removing the shim.
 */

import { mock } from "bun:test";

// Pass-through the pane-lock + pane-tag functions from their sub-modules so
// the mocked `../../src/core/transport/tmux` barrel matches the real surface.
// Tests that actually exercise locking/tagging should pass an `opts.tmux`
// override — the pass-throughs themselves are side-effect-free at import.
import {
  withPaneLock as realWithPaneLock,
  splitWindowLocked as realSplitWindowLocked,
} from "../../src/core/transport/tmux-pane-lock";
import {
  tagPane as realTagPane,
  readPaneTags as realReadPaneTags,
} from "../../src/core/transport/tmux-pane-tags";

// --- Public types ---

export interface MockSession {
  name: string;
  windows: { index: number; name: string; active: boolean }[];
}

export interface MockPeer {
  url: string;
  sessions: MockSession[];
}

// --- Internal state (cleared by resetMocks) ---

let tmuxConfig: { sessions: MockSession[] } | null = null;
let peersConfig: { peers: MockPeer[] } | null = null;
let paneCommands: Record<string, string> = {};
let capturedCommands: string[] = [];

// --- Shim install latches (shim stays live; config is what changes) ---

let tmuxShimInstalled = false;
let peersShimInstalled = false;

// --- Helpers ---

function cloneSessions(sessions: MockSession[]): MockSession[] {
  return sessions.map(s => ({
    name: s.name,
    windows: s.windows.map(w => ({ ...w })),
  }));
}

// --- Tmux mock ---

/**
 * Install the tmux mock. Replaces `../../src/core/transport/tmux` with a
 * shim whose `tmux.listAll()` / `Tmux#listAll()` returns `config.sessions`.
 *
 * Safe to call repeatedly — only the underlying shim is installed once;
 * subsequent calls just swap the config.
 */
export function installTmuxMock(config: { sessions: MockSession[] }): void {
  tmuxConfig = { sessions: cloneSessions(config.sessions) };
  if (tmuxShimInstalled) return;
  tmuxShimInstalled = true;

  mock.module("../../src/core/transport/tmux", () => {
    const impl = {
      async listAll() {
        capturedCommands.push(
          "tmux list-windows -a -F #{session_name}|||#{window_index}|||#{window_name}|||#{window_active}|||#{pane_current_path}",
        );
        return cloneSessions(tmuxConfig?.sessions ?? []);
      },
      async listSessions() {
        capturedCommands.push("tmux list-sessions -F #{session_name}");
        return cloneSessions(tmuxConfig?.sessions ?? []);
      },
      async listWindows(session: string) {
        capturedCommands.push(`tmux list-windows -t ${session}`);
        const s = (tmuxConfig?.sessions ?? []).find(x => x.name === session);
        return s ? s.windows.map(w => ({ ...w })) : [];
      },
      async hasSession(name: string) {
        capturedCommands.push(`tmux has-session -t ${name}`);
        return (tmuxConfig?.sessions ?? []).some(s => s.name === name);
      },
      async newSession(name: string, _opts: any = {}) {
        capturedCommands.push(`tmux new-session -s ${name}`);
      },
      async newGroupedSession(parent: string, name: string, _opts: any) {
        capturedCommands.push(`tmux new-session -d -t ${parent} -s ${name}`);
      },
      async killSession(name: string) {
        capturedCommands.push(`tmux kill-session -t ${name}`);
      },
      async newWindow(session: string, winName: string, _opts: any = {}) {
        capturedCommands.push(`tmux new-window -t ${session}: -n ${winName}`);
      },
      async selectWindow(target: string) {
        capturedCommands.push(`tmux select-window -t ${target}`);
      },
      async switchClient(session: string) {
        capturedCommands.push(`tmux switch-client -t ${session}`);
      },
      async killWindow(target: string) {
        capturedCommands.push(`tmux kill-window -t ${target}`);
      },
      async listPaneIds() {
        capturedCommands.push("tmux list-panes -a -F #{pane_id}");
        return new Set<string>();
      },
      async listPanes() {
        capturedCommands.push("tmux list-panes -a");
        return [];
      },
      async killPane(target: string) {
        capturedCommands.push(`tmux kill-pane -t ${target}`);
      },
      async getPaneCommand(target: string) {
        capturedCommands.push(`tmux list-panes -t ${target} -F #{pane_current_command}`);
        return paneCommands[target] ?? "";
      },
      async getPaneCommands(targets: string[]) {
        capturedCommands.push("tmux list-panes -a -F #{session_name}:#{window_index}|||#{pane_current_command}");
        const out: Record<string, string> = {};
        const targetSet = new Set(targets);
        for (const [t, cmd] of Object.entries(paneCommands)) {
          if (targetSet.has(t)) out[t] = cmd;
        }
        return out;
      },
      async getPaneInfo(target: string) {
        capturedCommands.push(`tmux list-panes -t ${target}`);
        return { command: paneCommands[target] ?? "", cwd: "/tmp" };
      },
      async getPaneInfos(targets: string[]) {
        const out: Record<string, { command: string; cwd: string }> = {};
        for (const t of targets) {
          out[t] = { command: paneCommands[t] ?? "", cwd: "/tmp" };
        }
        return out;
      },
      async capture(target: string, _lines = 80) {
        capturedCommands.push(`tmux capture-pane -t ${target}`);
        return "";
      },
      async resizePane(target: string, _cols: number, _rows: number) {
        capturedCommands.push(`tmux resize-pane -t ${target}`);
      },
      async splitWindow(target: string) {
        capturedCommands.push(`tmux split-window -t ${target}`);
      },
      async selectPane(target: string, _opts: any = {}) {
        capturedCommands.push(`tmux select-pane -t ${target}`);
      },
      async selectLayout(target: string, layout: string) {
        capturedCommands.push(`tmux select-layout -t ${target} ${layout}`);
      },
      async sendKeys(target: string, ...keys: string[]) {
        capturedCommands.push(`tmux send-keys -t ${target} ${keys.join(" ")}`);
      },
      async sendKeysLiteral(target: string, text: string) {
        capturedCommands.push(`tmux send-keys -t ${target} -l ${text}`);
      },
      async sendText(target: string, _text: string) {
        capturedCommands.push(`tmux send-text -t ${target}`);
      },
      async loadBuffer(_text: string) {
        capturedCommands.push("tmux load-buffer");
      },
      async pasteBuffer(target: string) {
        capturedCommands.push(`tmux paste-buffer -t ${target}`);
      },
      async setEnvironment(session: string, key: string, value: string) {
        capturedCommands.push(`tmux set-environment -t ${session} ${key} ${value}`);
      },
      async setOption(target: string, option: string, value: string) {
        capturedCommands.push(`tmux set-option -t ${target} ${option} ${value}`);
      },
      async set(target: string, option: string, value: string) {
        capturedCommands.push(`tmux set -t ${target} ${option} ${value}`);
      },
      async run(sub: string, ...args: (string | number)[]) {
        capturedCommands.push(`tmux ${sub} ${args.join(" ")}`);
        return "";
      },
      async tryRun(sub: string, ...args: (string | number)[]) {
        capturedCommands.push(`tmux ${sub} ${args.join(" ")}`);
        return "";
      },
    };

    // Class shim — real code does `new Tmux(host)`; we make it return an
    // instance that delegates to the same shared impl. Host/socket args
    // are accepted but ignored (they'd be irrelevant in a mock anyway).
    class MockTmux {
      constructor(public host?: string, public socket?: string) {}
    }
    Object.assign(MockTmux.prototype, impl);

    return {
      tmux: impl,
      Tmux: MockTmux,
      resolveSocket: () => undefined,
      tmuxCmd: () => "tmux",
      withPaneLock: realWithPaneLock,
      splitWindowLocked: realSplitWindowLocked,
      tagPane: realTagPane,
      readPaneTags: realReadPaneTags,
    };
  });
}

// --- Peers mock ---

/**
 * Install the peers mock. Replaces `../../src/core/transport/peers` with
 * a shim whose `getPeers()` returns the configured peer URLs and whose
 * `getAggregatedSessions()` merges local sessions with the configured
 * peer sessions (tagged with `source: <peer url>`).
 */
export function installPeersMock(config: { peers: MockPeer[] }): void {
  peersConfig = { peers: config.peers.map(p => ({ url: p.url, sessions: cloneSessions(p.sessions) })) };
  if (peersShimInstalled) return;
  peersShimInstalled = true;

  mock.module("../../src/core/transport/peers", () => ({
    getPeers(): string[] {
      return (peersConfig?.peers ?? []).map(p => p.url);
    },
    async getAggregatedSessions(localSessions: any[]) {
      const local = localSessions.map(s => ({ ...s, source: "local" }));
      const peerTagged = (peersConfig?.peers ?? []).flatMap(p =>
        p.sessions.map(s => ({ ...cloneSessions([s])[0], source: p.url })),
      );
      // Dedup by source + name to mirror real implementation
      const seen = new Set<string>();
      const peers = peerTagged.filter(s => {
        const key = `${s.source}:${s.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return [...local, ...peers];
    },
    async getFederationStatus() {
      const peers = peersConfig?.peers ?? [];
      return {
        localUrl: "http://localhost:3456",
        peers: peers.map(p => ({
          url: p.url,
          reachable: true,
          latency: 1,
        })),
        totalPeers: peers.length,
        reachablePeers: peers.length,
        clockHealth: {
          clockUtc: new Date().toISOString(),
          timezone: "UTC",
          uptimeSeconds: 1,
        },
      };
    },
    async findPeerForTarget(target: string, _localSessions: any[]) {
      for (const p of peersConfig?.peers ?? []) {
        const hit = p.sessions.some(
          s => s.name === target || s.windows.some(w => `${s.name}:${w.index}` === target),
        );
        if (hit) return p.url;
      }
      return null;
    },
    async sendKeysToPeer(_peerUrl: string, _target: string, _text: string) {
      return true;
    },
  }));
}

// --- Controls ---

/**
 * Configure what `getPaneCommand()` / `getPaneCommands()` returns for
 * each target. Example: `{ "oracles:1": "claude", "oracles:2": "zsh" }`.
 * Replaces (not merges) the previous map — call this inside beforeEach.
 */
export function setPaneCommands(cmds: Record<string, string>): void {
  paneCommands = { ...cmds };
}

/** Captured tmux commands issued through the mock (for assertions). */
export function getCapturedCommands(): string[] {
  return [...capturedCommands];
}

/**
 * Clear all mock state. Call in afterEach to prevent leakage between
 * tests. The underlying mock.module() shim stays in place (bun has no
 * mechanism to un-install); clearing config makes subsequent reads
 * return empty sessions / no peers — the natural "tmux not running,
 * no federation" state.
 */
export function resetMocks(): void {
  tmuxConfig = null;
  peersConfig = null;
  paneCommands = {};
  capturedCommands = [];
}
