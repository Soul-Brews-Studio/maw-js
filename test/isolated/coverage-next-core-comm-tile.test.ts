import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockConfigModule } from "../helpers/mock-config";

let configValue: Record<string, any> = {};
let sessionsReturn: any[] = [];
let resolveTargetReturn: any = null;
let paneCommand = "claude";
let captureImpl: (target: string, lines?: number, host?: string) => Promise<string> = async () => "agent ready\n";
let curlFetchReturn: any = { ok: true, data: { ok: true } };
let peerForTarget: string | null = null;
let sendKeysCalls: Array<[string, string]> = [];
let hookCalls: Array<[string, unknown]> = [];
let logMessages: unknown[][] = [];
let feedEvents: unknown[] = [];
let hostExecCalls: string[] = [];
let hostExecImpl: (cmd: string) => Promise<string> = async () => "";
let layoutCalls: string[] = [];
let borderCalls: unknown[] = [];
let logs: string[] = [];
let errors: string[] = [];

mock.module(import.meta.resolve("../../src/sdk"), () => ({
  FLEET_DIR: "/tmp/nonexistent-fleet-next-core",
  listSessions: async () => sessionsReturn,
  capture: async (target: string, lines?: number, host?: string) => captureImpl(target, lines, host),
  sendKeys: async (target: string, text: string) => { sendKeysCalls.push([target, text]); },
  getPaneCommand: async () => paneCommand,
  isAgentCommand: (cmd: string) => ["claude", "codex", "node"].includes(cmd),
  findPeerForTarget: async () => peerForTarget,
  resolveTarget: () => resolveTargetReturn,
  curlFetch: async () => curlFetchReturn,
  runHook: async (name: string, payload: unknown) => { hookCalls.push([name, payload]); },
  tmux: {
    listSessions: async () => [],
    setEnvironment: async () => {},
    hasSession: async () => true,
    run: async () => "",
  },
  restoreTabOrder: async () => 0,
  takeSnapshot: async () => {},
  getPaneInfos: async () => ({}),
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return hostExecImpl(cmd);
  },
}));

mock.module(import.meta.resolve("../../src/core/transport/tmux"), () => ({
  tmuxCmd: (...args: Array<string | number>) => `tmux ${args.join(" ")}`,
  tmux: {
    listSessions: async () => [],
    setEnvironment: async () => {},
    hasSession: async () => true,
    run: async () => "",
  },
  Tmux: class {
    async run(...args: string[]) {
      hostExecCalls.push(`tmux ${args.join(" ")}`);
      return hostExecImpl(args.join(" "));
    }
  },
}));

mock.module(import.meta.resolve("../../src/config"), () => ({
  ...mockConfigModule(() => configValue),
  loadConfig: () => configValue,
  cfgLimit: () => 80,
}));

mock.module(import.meta.resolve("../../src/commands/shared/comm-log-feed"), () => ({
  logMessage: (...args: unknown[]) => { logMessages.push(args); },
  emitFeed: (...args: unknown[]) => { feedEvents.push(args); },
}));

mock.module(import.meta.resolve("../../src/lib/message-events"), () => ({
  buildMessageLifecycleFeedEvent: (input: any) => ({
    event: input.channel,
    oracle: input.to,
    host: input.route,
    message: input.text,
    data: input,
  }),
}));

mock.module(import.meta.resolve("../../src/commands/shared/receiver-inbox"), () => ({
  defaultReceiverInboxWriter: () => async () => null,
}));

mock.module(import.meta.resolve("../../src/commands/plugins/tmux/layout-manager"), () => ({
  nextAgentColor: (idx: number) => `color-${idx}`,
  colorAnsi: () => 36,
  stylePaneBorder: async (...args: unknown[]) => { borderCalls.push(args); },
  enableBorderStatus: async (window: string) => { layoutCalls.push(`enable:${window}`); },
  applyTiledLayout: async (window: string) => { layoutCalls.push(`grid:${window}`); },
}));

mock.module(import.meta.resolve("../../src/core/transport/tmux-pane-lock"), () => ({
  withPaneLock: async (fn: () => Promise<void>) => fn(),
}));

const commSend = await import("../../src/commands/shared/comm-send.ts?coverage-next-core-comm-tile");
const tileImpl = await import("../../src/commands/plugins/tile/impl.ts?coverage-next-core-comm-tile");

const original = {
  agentName: process.env.CLAUDE_AGENT_NAME,
  pane: process.env.TMUX_PANE,
  log: console.log,
  error: console.error,
  exit: process.exit,
  sleep: Bun.sleep,
};

beforeEach(() => {
  configValue = { node: "m5", oracle: "sender", port: 3456, env: {}, commands: { fast: "run-fast" }, sessions: {}, agents: {} };
  sessionsReturn = [];
  resolveTargetReturn = null;
  paneCommand = "claude";
  captureImpl = async () => "agent ready\n";
  curlFetchReturn = { ok: true, data: { ok: true } };
  peerForTarget = null;
  sendKeysCalls = [];
  hookCalls = [];
  logMessages = [];
  feedEvents = [];
  hostExecCalls = [];
  hostExecImpl = async (cmd: string) => {
    if (cmd.includes("#{session_name}:#{window_index}.#{pane_index}")) return "sess:1.0\n";
    if (cmd.includes("#{session_name}:#{window_index}")) return "sess:1\n";
    if (cmd.includes("#{window_id}")) return "@win\n";
    if (cmd.includes("#{pane_id}|||#{pane_title}|||#{@maw_tile}")) return "%lead|||lead|||\n%old|||tile-1|||1\n";
    if (cmd.includes("tmux split-window")) return "%new\n";
    if (cmd.includes("#{pane_id}")) return "%lead\n%old\n%new\n";
    return "";
  };
  layoutCalls = [];
  borderCalls = [];
  logs = [];
  errors = [];
  process.env.CLAUDE_AGENT_NAME = "sender";
  process.env.TMUX_PANE = "%lead";
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  Bun.sleep = (async () => {}) as typeof Bun.sleep;
});

afterEach(() => {
  if (original.agentName === undefined) delete process.env.CLAUDE_AGENT_NAME; else process.env.CLAUDE_AGENT_NAME = original.agentName;
  if (original.pane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = original.pane;
  console.log = original.log;
  console.error = original.error;
  process.exit = original.exit;
  Bun.sleep = original.sleep;
});

describe("coverage next comm-send helpers", () => {
  test("resolveOraclePane selects the lowest agent pane and preserves fallback targets", async () => {
    await expect(commSend.resolveOraclePane("sess:win.3")).resolves.toBe("sess:win.3");

    await expect(commSend.resolveOraclePane("sess:win", {
      tmuxRun: async () => "1 zsh\n0 node\n2 codex\ninvalid",
      isAgentCommandFn: (cmd: string) => cmd === "node" || cmd === "codex",
    })).resolves.toBe("sess:win.0");

    await expect(commSend.resolveOraclePane("sess:win", {
      tmuxRun: async () => { throw new Error("tmux unavailable"); },
    })).resolves.toBe("sess:win");
  });

  test("message helpers preserve commands and resolve workspace window names", () => {
    expect(commSend.formatSignedMessage(" /cmd", configValue, "sender")).toBe(" /cmd");
    expect(commSend.formatSignedMessage("[m5:sender] hello", configValue, "sender")).toBe("[m5:sender] hello");
    expect(commSend.formatSignedMessage("  hello", configValue, "sender")).toBe("  [m5:sender] hello");
    expect(commSend.resolveMyName(configValue as any)).toBe("sender");
    expect(commSend.resolveTeamWorkspaceMemberTarget("crew", "opal", [
      { name: "crew", windows: [{ index: 1, name: "opal-oracle", active: false }] },
    ] as any)).toBe("crew:opal-oracle");
    expect(commSend.resolveTeamWorkspaceMemberTarget("crew", "missing", [] as any)).toBeNull();
  });

  test("cmdSend queues receiver inbox without pane injection when --inbox is requested", async () => {
    resolveTargetReturn = { type: "local", target: "sess:agent.0" };
    paneCommand = "node";
    const inboxWrites: unknown[] = [];

    await commSend.cmdSend("m5:sess:agent", "hello", false, {
      inboxOnly: true,
      receiverInbox: async (input) => {
        inboxWrites.push(input);
        return { ok: true, oracle: "agent", filename: "queued.json" } as any;
      },
    });

    expect(inboxWrites).toHaveLength(1);
    expect(sendKeysCalls).toEqual([]);
    expect(logMessages.at(-1)).toEqual(["sender", "m5:sess:agent", "[m5:sender] hello", "inbox"]);
    expect(logs.join("\n")).toContain("queued");
  });

  test("cmdSend sends forced local messages and records capture failures as empty tails", async () => {
    resolveTargetReturn = { type: "local", target: "sess:agent.0" };
    captureImpl = async () => { throw new Error("capture failed"); };

    await commSend.cmdSend("m5:sess:agent", "$keep-command", true, { receiverInbox: false });

    expect(sendKeysCalls).toEqual([["sess:agent.0", "$keep-command"]]);
    expect(hookCalls).toEqual([["after_send", { to: "m5:sess:agent", message: "$keep-command" }]]);
    expect((feedEvents.at(-1) as any[])[5]).toMatchObject({ state: "delivered", lastLine: "" });
  });

  test("cmdSend reports peer delivery failures without discovery fallback", async () => {
    resolveTargetReturn = { type: "peer", peerUrl: "http://peer.local", target: "agent", node: "peer" };
    curlFetchReturn = { ok: false, status: 502, data: { error: "down" } };
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; throw new Error(`exit:${code}`); }) as never;

    await expect(commSend.cmdSend("peer:agent", "hello", false, { receiverInbox: false })).rejects.toThrow("exit:1");

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Remote fetch failed");
    expect((feedEvents.at(-1) as any[])[5]).toMatchObject({ state: "failed", error: "down" });
  });
});

describe("coverage next tile impl", () => {
  test("cmdTile maps configured engine commands and accounts for existing tile panes", async () => {
    await tileImpl.cmdTile(1, { engine: "fast" });

    const split = hostExecCalls.find((cmd) => cmd.includes("tmux split-window"));
    expect(split).toContain("exec zsh");
    expect(split).not.toContain("run-fast");
    expect(hostExecCalls).toContain("tmux send-keys -t '%new' -l 'run-fast'");
    expect(hostExecCalls).toContain("tmux send-keys -t '%new' Enter");
    expect(split).toContain("MAW_TILE_INDEX='\\''2'\\''");
    expect(borderCalls).toEqual([["%new", "sess-tile-2", "color-0"]]);
    expect(layoutCalls).toContain("enable:@win");
  });

  test("cmdTileClean tolerates disappearing panes and reports no remaining cleanup", async () => {
    hostExecImpl = async (cmd: string) => {
      if (cmd.includes("#{window_id}")) return "@win\n";
      if (cmd.includes("#{pane_id}|||#{pane_title}|||#{@maw_tile}")) return "%lead|||lead|||\n%gone|||tile-2|||1\n";
      if (cmd.includes("kill-pane")) throw new Error("already gone");
      if (cmd.includes("git rev-parse --show-toplevel")) throw new Error("not a repo");
      return "";
    };

    await tileImpl.cmdTileClean();

    expect(hostExecCalls).toContain("tmux kill-pane -t '%gone'");
    expect(logs).toContain("\x1b[90mno tile panes or worktrees to clean\x1b[0m");
  });
});
