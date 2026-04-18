/**
 * view-split-anchor.test.ts — #545 cmdView splitAnchor contract.
 *
 * Covers src/commands/plugins/view/impl.ts:
 *   - splitAnchor === undefined     → NO cmdSplit call (attach path runs)
 *   - splitAnchor === true          → cmdSplit(viewName, { anchorPane: undefined })
 *   - splitAnchor === "<name>"      → resolveAnchorPane:
 *                                      a) hasSession("<name>-view") hit  → anchorPane = "<name>-view:0"
 *                                         (no newGroupedSession)
 *                                      b) no <name>-view, but <name> session exists →
 *                                         newGroupedSession(<name>, "<name>-view"), then
 *                                         anchorPane = "<name>-view:0"
 *                                      c) neither view nor session matches → throws
 *   - splitAnchor === "<s>:<w>"     → anchorPane passed through verbatim (no resolution)
 *
 * Mocked seams: src/sdk (listSessions, Tmux, tmuxCmd, resolveSocket),
 *               src/config (loadConfig),
 *               src/core/fleet/audit (logAnomaly),
 *               src/commands/plugins/split/impl (cmdSplit).
 */
import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { join } from "path";

// ─── Mutable mock state ──────────────────────────────────────────────────────

type FakeSession = { name: string; windows: { index: number; name: string; active: boolean }[] };

let fakeSessions: FakeSession[] = [];
let existingViewSessions: Set<string> = new Set();
let newGroupedCalls: Array<{ parent: string; name: string }> = [];
let switchClientCalls: string[] = [];
let cmdSplitCalls: Array<{ target: string; opts: { anchorPane?: string } }> = [];

// ─── Mocks (install BEFORE importing the module-under-test) ──────────────────

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  listSessions: async () => fakeSessions,
  tmuxCmd: () => "tmux",
  resolveSocket: () => undefined,
  Tmux: class {
    async hasSession(name: string) {
      return existingViewSessions.has(name) || fakeSessions.some(s => s.name === name);
    }
    async newGroupedSession(parent: string, name: string, _opts?: unknown) {
      newGroupedCalls.push({ parent, name });
      existingViewSessions.add(name);
    }
    async selectWindow(_target: string) {}
    async set(_target: string, _option: string, _value: string) {}
    async switchClient(target: string) {
      switchClientCalls.push(target);
    }
    async killSession(_target: string) {}
  },
}));

mock.module(join(import.meta.dir, "../../src/config"), () => ({
  loadConfig: () => ({ host: "local" }),
}));

mock.module(join(import.meta.dir, "../../src/core/fleet/audit"), () => ({
  logAnomaly: () => {},
}));

mock.module(join(import.meta.dir, "../../src/commands/plugins/split/impl"), () => ({
  cmdSplit: async (target: string, opts: { anchorPane?: string } = {}) => {
    cmdSplitCalls.push({ target, opts });
  },
}));

const { cmdView } = await import("../../src/commands/plugins/view/impl");

// ─── Harness ─────────────────────────────────────────────────────────────────

const origLog = console.log;
const origError = console.error;
let savedTmux: string | undefined;

function silenceConsole() {
  console.log = () => {};
  console.error = () => {};
}

beforeEach(() => {
  savedTmux = process.env.TMUX;
  // Set TMUX so cmdView takes the switchClient path (never touches execSync).
  process.env.TMUX = "/tmp/tmux-test";
  fakeSessions = [];
  existingViewSessions = new Set();
  newGroupedCalls = [];
  switchClientCalls = [];
  cmdSplitCalls = [];
  silenceConsole();
});

afterEach(() => {
  console.log = origLog;
  console.error = origError;
  if (savedTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = savedTmux;
});

afterAll(() => {
  console.log = origLog;
  console.error = origError;
});

// Session fixtures. "mawjs" is the agent used across tests — resolves to
// the fleet-numbered session 101-mawjs → viewName becomes "mawjs-view".
function baseSessions(): FakeSession[] {
  return [
    { name: "101-mawjs", windows: [{ index: 0, name: "oracle", active: true }] },
  ];
}

// ─── cmdView splitAnchor (#545) ──────────────────────────────────────────────

describe("cmdView splitAnchor (#545)", () => {
  test("splitAnchor === undefined → cmdSplit NOT called (existing behavior preserved)", async () => {
    fakeSessions = baseSessions();
    await cmdView("mawjs", undefined, false, false, undefined);
    expect(cmdSplitCalls.length).toBe(0);
    // Attach path ran instead.
    expect(switchClientCalls).toEqual(["mawjs-view"]);
  });

  test("splitAnchor === true → cmdSplit(viewName, { anchorPane: undefined }), no switchClient", async () => {
    fakeSessions = baseSessions();
    await cmdView("mawjs", undefined, false, false, true);
    expect(cmdSplitCalls.length).toBe(1);
    expect(cmdSplitCalls[0]!.target).toBe("mawjs-view");
    expect(cmdSplitCalls[0]!.opts.anchorPane).toBeUndefined();
    // Split path returns before attach — no switchClient fired.
    expect(switchClientCalls.length).toBe(0);
  });

  test("splitAnchor === '<name>' with existing <name>-view → anchorPane = '<name>-view:0', NO newGroupedSession", async () => {
    fakeSessions = baseSessions();
    // Simulate: other-view already exists (from an earlier `maw view other`)
    existingViewSessions.add("other-view");
    await cmdView("mawjs", undefined, false, false, "other");
    expect(cmdSplitCalls.length).toBe(1);
    expect(cmdSplitCalls[0]!.target).toBe("mawjs-view");
    expect(cmdSplitCalls[0]!.opts.anchorPane).toBe("other-view:0");
    // hasSession hit — no bootstrap needed for the anchor.
    expect(newGroupedCalls.find(c => c.name === "other-view")).toBeUndefined();
  });

  test("splitAnchor === '<name>' with NO <name>-view → bootstraps via newGroupedSession, anchorPane = '<name>-view:0'", async () => {
    fakeSessions = [
      ...baseSessions(),
      { name: "102-other", windows: [{ index: 0, name: "oracle", active: true }] },
    ];
    // No "other-view" pre-exists — resolveAnchorPane must bootstrap it.
    await cmdView("mawjs", undefined, false, false, "other");
    expect(cmdSplitCalls.length).toBe(1);
    expect(cmdSplitCalls[0]!.opts.anchorPane).toBe("other-view:0");
    // Bootstrap call: parent = resolved "other" session, name = "other-view"
    const bootstrap = newGroupedCalls.find(c => c.name === "other-view");
    expect(bootstrap).toBeDefined();
    expect(bootstrap!.parent).toBe("102-other");
  });

  test("splitAnchor === '<session>:<win>' → anchorPane passed verbatim (no resolution, no bootstrap)", async () => {
    fakeSessions = baseSessions();
    await cmdView("mawjs", undefined, false, false, "other:main");
    expect(cmdSplitCalls.length).toBe(1);
    expect(cmdSplitCalls[0]!.target).toBe("mawjs-view");
    expect(cmdSplitCalls[0]!.opts.anchorPane).toBe("other:main");
    // No bootstrap — explicit session:window is trusted as-is.
    expect(newGroupedCalls.find(c => c.name === "other:main-view")).toBeUndefined();
    expect(newGroupedCalls.find(c => c.name === "other-view")).toBeUndefined();
  });

  test("splitAnchor === '<unknown>' with no matching session or view → throws", async () => {
    fakeSessions = baseSessions(); // only 101-mawjs — "nosuch" matches nothing
    await expect(
      cmdView("mawjs", undefined, false, false, "nosuch"),
    ).rejects.toThrow(/--split=nosuch|no matching session|no matching/i);
    expect(cmdSplitCalls.length).toBe(0);
  });
});
