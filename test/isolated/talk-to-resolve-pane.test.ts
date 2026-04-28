/**
 * test/isolated/talk-to-resolve-pane.test.ts
 *
 * #764: `maw talk-to` must call resolveOraclePane on the resolved local
 * target so multi-pane oracle windows (team-agents spawned beside the
 * oracle) deliver to the oracle's claude pane, not whichever pane is
 * currently active.
 *
 * Mirrors the comm-send-resolve-pane.test.ts pattern: stub the tmux
 * transport's list-panes return value, then assert sendKeys was called
 * with the pane-suffixed target (e.g. "08-mawjs:1.0") rather than the
 * bare window target ("08-mawjs:1").
 *
 * Isolated because mock.module is process-global.
 */
import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { join } from "path";
import { mockConfigModule } from "../helpers/mock-config";

const srcRoot = join(import.meta.dir, "../..");

// Capture the real tmux transport types BEFORE mock.module replaces it.
const _rTmux = await import("../../src/core/transport/tmux");

// --- Mutable tmux stub state ---
let listPanesReturn = "";
let lastListPanesArgs: (string | number)[] = [];

// --- Mock tmux transport (resolveOraclePane uses `new Tmux().run("list-panes", ...)`) ---
mock.module(join(srcRoot, "src/core/transport/tmux"), () => {
  class MockTmux {
    constructor(public host?: string, public socket?: string) {}
    async run(subcommand: string, ...args: (string | number)[]): Promise<string> {
      if (subcommand === "list-panes") {
        lastListPanesArgs = args;
        return listPanesReturn;
      }
      return "";
    }
    async tryRun(subcommand: string, ...args: (string | number)[]): Promise<string> {
      return this.run(subcommand, ...args);
    }
  }
  return {
    ..._rTmux,
    Tmux: MockTmux,
    tmux: new MockTmux(),
  };
});

// --- Mutable sdk stub state ---
type SessionRow = { name: string; windows: { index: number; name: string; active: boolean }[]; source?: string };
let sessionsToReturn: SessionRow[] = [];
let sendKeysCalls: { target: string; message: string }[] = [];

// Use the real resolveTarget so the local resolution path is exercised end-to-end.
const realRouting = await import("../../src/core/routing");

mock.module(join(srcRoot, "src/sdk"), () => ({
  listSessions: async () => sessionsToReturn,
  sendKeys: async (target: string, message: string) => {
    sendKeysCalls.push({ target, message });
  },
  getPaneCommand: async () => "claude",
  resolveTarget: realRouting.resolveTarget,
  runHook: async () => {},
}));

mock.module(join(srcRoot, "src/config"), () =>
  mockConfigModule(() => ({
    node: "white",
    namedPeers: [],
    agents: {},
    peers: [],
    oracleUrl: "http://oracle.invalid:1",
  })),
);

// --- Stub fetch (Oracle thread API) ---
const origFetch = globalThis.fetch;
const origLog = console.log;
const origErr = console.error;

// --- Import module under test AFTER all mocks installed ---
const { cmdTalkTo } = await import("../../src/commands/plugins/talk-to/impl");

beforeEach(() => {
  sessionsToReturn = [];
  sendKeysCalls = [];
  listPanesReturn = "";
  lastListPanesArgs = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/threads?limit=50")) {
      return new Response(JSON.stringify({ threads: [] }), { status: 200 });
    }
    if (url.endsWith("/api/thread")) {
      return new Response(JSON.stringify({ thread_id: 42, message_id: 1, status: "ok" }), { status: 200 });
    }
    if (url.includes("/api/thread/")) {
      return new Response(
        JSON.stringify({ thread: { id: 42, title: "x", status: "open", created_at: "" }, messages: [] }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  console.log = () => {};
  console.error = () => {};
});

afterEach(() => {
  globalThis.fetch = origFetch;
  console.log = origLog;
  console.error = origErr;
});

afterAll(() => {
  globalThis.fetch = origFetch;
  console.log = origLog;
  console.error = origErr;
});

describe("cmdTalkTo — #764 multi-pane oracle resolution", () => {
  test("multi-pane window: sendKeys targets the lowest-index agent pane, not the bare window", async () => {
    // Oracle window has two panes: pane 0 = claude (oracle), pane 1 = node (team-agent split).
    // Without resolveOraclePane, sendKeys would land on whichever pane is active —
    // typically the just-spawned teammate at pane 1.
    sessionsToReturn = [
      { name: "08-mawjs", windows: [{ index: 1, name: "mawjs-oracle", active: true }] },
    ];
    listPanesReturn = "0 claude\n1 node\n";

    await cmdTalkTo("mawjs-oracle", "hi");

    // resolveOraclePane was called with the window-level target.
    expect(lastListPanesArgs).toEqual(["-t", "08-mawjs:1", "-F", "#{pane_index} #{pane_current_command}"]);
    // sendKeys received the pane-suffixed target.
    expect(sendKeysCalls).toHaveLength(1);
    expect(sendKeysCalls[0].target).toBe("08-mawjs:1.0");
  });

  test("single-pane window: sendKeys uses the unmodified window target", async () => {
    sessionsToReturn = [
      { name: "08-mawjs", windows: [{ index: 1, name: "mawjs-oracle", active: true }] },
    ];
    listPanesReturn = "0 claude\n";

    await cmdTalkTo("mawjs-oracle", "hi");

    expect(sendKeysCalls).toHaveLength(1);
    // Single-pane short-circuit: target unchanged.
    expect(sendKeysCalls[0].target).toBe("08-mawjs:1");
  });

  test("multi-pane window with split positions reordered: still picks the lowest agent pane", async () => {
    // Even if claude got assigned a higher pane index due to splits, the pane
    // running an agent process with the smallest index wins.
    sessionsToReturn = [
      { name: "08-mawjs", windows: [{ index: 1, name: "mawjs-oracle", active: true }] },
    ];
    // pane 0 = zsh (a leftover shell), pane 1 = claude, pane 2 = node
    listPanesReturn = "0 zsh\n1 claude\n2 node\n";

    await cmdTalkTo("mawjs-oracle", "hi");

    expect(sendKeysCalls).toHaveLength(1);
    expect(sendKeysCalls[0].target).toBe("08-mawjs:1.1");
  });
});
