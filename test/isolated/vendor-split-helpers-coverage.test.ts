/** Targeted isolated coverage for the canonical vendor split helper implementation. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type Session = {
  name: string;
  windows: Array<{ index?: number; name?: string }>;
};

type ResolveResult =
  | { kind: "match"; match: Session }
  | { kind: "ambiguous"; candidates: Session[] }
  | { kind: "none"; hints?: Session[] };

type CmdSplit = (target: string, opts?: {
  pct?: number;
  vertical?: boolean;
  noAttach?: boolean;
  lock?: boolean;
  settleMs?: number;
  anchorPane?: string;
  claudePanePolicy?: string;
}) => Promise<void>;

let sessions: Session[] = [];
let resolveResults = new Map<string, ResolveResult>();
let resolveCalls: Array<{ target: string; sessions: Session[] }> = [];
let listSessionsCalls = 0;
let hostExecCalls: string[] = [];
let hostExecFailure: unknown = null;
let hostExecFailureNeedles: string[] = [];
let paneCommandResponse = "";
let anchorSessionResponse = "";
let clientTtyResponse = "";
let newWindowResponse = "@42";
let lockEvents: string[] = [];
let normalizeCalls: string[] = [];
let normalizeImpl: (target: string) => string = (target) => target;
let logs: string[] = [];
let errors: string[] = [];

const original = {
  log: console.log,
  error: console.error,
  tmux: process.env.TMUX,
  tmuxPane: process.env.TMUX_PANE,
  forceSplit: process.env.MAW_FORCE_SPLIT,
  allowClaudeSplit: process.env.MAW_ALLOW_CLAUDE_SPLIT,
};

mock.module("maw-js/sdk", () => ({
  listSessions: async () => {
    listSessionsCalls += 1;
    return sessions;
  },
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    if (hostExecFailure) throw hostExecFailure;
    if (hostExecFailureNeedles.some((needle) => cmd.includes(needle))) throw new Error(`tmux probe failed: ${cmd}`);
    if (cmd.includes("#{pane_current_command}")) return paneCommandResponse;
    if (cmd.includes("#{session_name}")) return anchorSessionResponse;
    if (cmd.includes("#{client_tty}")) return clientTtyResponse;
    if (cmd.startsWith("tmux new-window ")) return newWindowResponse;
    return "";
  },
  withPaneLock: async (fn: () => Promise<void>) => {
    lockEvents.push("lock:start");
    try {
      await fn();
    } finally {
      lockEvents.push("lock:end");
    }
  },
}));

mock.module("maw-js/core/matcher/resolve-target", () => ({
  resolveSessionTarget: (target: string, seenSessions: Session[]) => {
    resolveCalls.push({ target, sessions: seenSessions });
    return resolveResults.get(target) ?? { kind: "none", hints: [] };
  },
}));

mock.module("maw-js/core/matcher/normalize-target", () => ({
  normalizeTarget: (target: string) => {
    normalizeCalls.push(target);
    return normalizeImpl(target);
  },
}));

const split = await import("../../src/vendor/mpr-plugins/split/impl.ts?vendor-split-helpers-coverage");

const helpers: Array<{ label: string; cmdSplit: CmdSplit }> = [
  { label: "split/impl", cmdSplit: split.cmdSplit },
];

function stdout(): string {
  return logs.join("\n");
}

function stderr(): string {
  return errors.join("\n");
}

function resetCalls(): void {
  resolveCalls = [];
  listSessionsCalls = 0;
  hostExecCalls = [];
  lockEvents = [];
  normalizeCalls = [];
  logs = [];
  errors = [];
}

beforeEach(() => {
  sessions = [];
  resolveResults = new Map();
  hostExecFailure = null;
  hostExecFailureNeedles = [];
  paneCommandResponse = "";
  anchorSessionResponse = "";
  clientTtyResponse = "";
  newWindowResponse = "@42";
  normalizeImpl = (target) => target;
  process.env.TMUX = "/tmp/tmux-test";
  process.env.TMUX_PANE = "%7";
  delete process.env.MAW_FORCE_SPLIT;
  delete process.env.MAW_ALLOW_CLAUDE_SPLIT;
  resetCalls();
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = original.log;
  console.error = original.error;
  if (original.tmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = original.tmux;
  if (original.tmuxPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = original.tmuxPane;
  if (original.forceSplit === undefined) delete process.env.MAW_FORCE_SPLIT;
  else process.env.MAW_FORCE_SPLIT = original.forceSplit;
  if (original.allowClaudeSplit === undefined) delete process.env.MAW_ALLOW_CLAUDE_SPLIT;
  else process.env.MAW_ALLOW_CLAUDE_SPLIT = original.allowClaudeSplit;
});

for (const helper of helpers) {
  describe(`${helper.label} cmdSplit`, () => {
    test("normalizes before rejecting calls outside tmux", async () => {
      delete process.env.TMUX;
      normalizeImpl = (target) => target.replace(/\/(?:\.git\/?)?$/, "");

      await expect(helper.cmdSplit("repo/.git/")).rejects.toThrow("maw split requires an active tmux session");

      expect(normalizeCalls).toEqual(["repo/.git/"]);
      expect(listSessionsCalls).toBe(0);
      expect(resolveCalls).toEqual([]);
      expect(hostExecCalls).toEqual([]);
    });

    test("prints usage and avoids side effects for empty normalized targets", async () => {
      normalizeImpl = () => "";

      await expect(helper.cmdSplit("anything/.git/")).rejects.toThrow(
        "usage: maw split <target> [--pct N] [--vertical] [--no-attach]",
      );

      expect(stderr()).toContain("usage: maw split <target>");
      expect(stderr()).toContain("maw split yeast");
      expect(listSessionsCalls).toBe(0);
      expect(resolveCalls).toEqual([]);
      expect(hostExecCalls).toEqual([]);
    });

    test("validates pct before resolving or shelling out", async () => {
      for (const pct of [Number.NaN, 0, 100]) {
        resetCalls();
        await expect(helper.cmdSplit("agent", { pct })).rejects.toThrow(`--pct must be 1-99 (got ${pct})`);
        expect(listSessionsCalls).toBe(0);
        expect(resolveCalls).toEqual([]);
        expect(hostExecCalls).toEqual([]);
      }
    });

    test("splits an explicit session target with defaults anchored to TMUX_PANE", async () => {
      await helper.cmdSplit("alpha:2");

      expect(listSessionsCalls).toBe(0);
      expect(resolveCalls).toEqual([]);
      expect(hostExecCalls).toEqual([
        `tmux display-message -p -t '%7' '#{pane_current_command}'`,
        `tmux split-window -t '%7' -h -l 50% "TMUX= tmux attach-session -t alpha:2"`,
      ]);
      expect(stdout()).toContain("split beside — alpha:2 (50%)");
    });

    test("supports vertical no-attach panes and escapes explicit anchors", async () => {
      await helper.cmdSplit("alpha:2", {
        pct: 33,
        vertical: true,
        noAttach: true,
        anchorPane: "%a'b",
      });

      const escapedAnchor = "%a'b".replace(/'/g, "'\\''");
      expect(hostExecCalls).toEqual([`tmux split-window -t '${escapedAnchor}' -v -l 33% "bash"`]);
      expect(stdout()).toContain("split below — empty pane (33%) (anchored at %a'b)");
    });

    test("resolves bare targets to their window index and falls back to window zero", async () => {
      const seenSessions = [
        { name: "01-alpha", windows: [{ index: 4, name: "work" }] },
        { name: "02-beta", windows: [] },
      ];
      sessions = seenSessions;
      resolveResults.set("alpha", { kind: "match", match: seenSessions[0] });

      await helper.cmdSplit("alpha");

      expect(listSessionsCalls).toBe(1);
      expect(resolveCalls).toEqual([{ target: "alpha", sessions: seenSessions }]);
      expect(hostExecCalls).toEqual([
        `tmux display-message -p -t '%7' '#{pane_current_command}'`,
        `tmux split-window -t '%7' -h -l 50% "TMUX= tmux attach-session -t 01-alpha:4"`,
      ]);
      expect(stdout()).toContain("split beside — 01-alpha:4 (50%)");

      resetCalls();
      delete process.env.TMUX_PANE;
      resolveResults.set("beta", { kind: "match", match: seenSessions[1] });

      await helper.cmdSplit("beta");

      expect(listSessionsCalls).toBe(1);
      expect(resolveCalls).toEqual([{ target: "beta", sessions: seenSessions }]);
      expect(hostExecCalls).toEqual([
        `tmux split-window -h -l 50% "TMUX= tmux attach-session -t 02-beta:0"`,
      ]);
      expect(stdout()).toContain("split beside — 02-beta:0 (50%)");
    });

    test("reports ambiguous bare targets with candidates and no tmux side effects", async () => {
      sessions = [
        { name: "east-alpha", windows: [{ index: 0 }] },
        { name: "west-alpha", windows: [{ index: 1 }] },
      ];
      resolveResults.set("alpha", { kind: "ambiguous", candidates: sessions });

      await expect(helper.cmdSplit("alpha")).rejects.toThrow("'alpha' is ambiguous");

      expect(listSessionsCalls).toBe(1);
      expect(stderr()).toContain("'alpha' is ambiguous — matches 2 sessions");
      expect(stderr()).toContain("east-alpha");
      expect(stderr()).toContain("west-alpha");
      expect(stderr()).toContain("use the full name");
      expect(hostExecCalls).toEqual([]);
    });

    test("reports missing bare targets with and without hints", async () => {
      sessions = [{ name: "01-oracle", windows: [{ index: 0 }] }];
      resolveResults.set("ghost", { kind: "none", hints: sessions });

      await expect(helper.cmdSplit("ghost")).rejects.toThrow("session 'ghost' not found in fleet");

      expect(stderr()).toContain("session 'ghost' not found in fleet");
      expect(stderr()).toContain("did you mean:");
      expect(stderr()).toContain("01-oracle");
      expect(hostExecCalls).toEqual([]);

      resetCalls();
      resolveResults.set("nobody", { kind: "none", hints: [] });

      await expect(helper.cmdSplit("nobody")).rejects.toThrow("session 'nobody' not found in fleet");

      expect(stderr()).toContain("session 'nobody' not found in fleet");
      expect(stderr()).not.toContain("did you mean:");
      expect(stderr()).toContain("try: maw ls");
      expect(hostExecCalls).toEqual([]);
    });

    test("serializes locked splits and covers settle/no-settle branches", async () => {
      await helper.cmdSplit("alpha:2", { lock: true, settleMs: 0 });

      expect(lockEvents).toEqual(["lock:start", "lock:end"]);
      expect(hostExecCalls).toEqual([
        `tmux display-message -p -t '%7' '#{pane_current_command}'`,
        `tmux split-window -t '%7' -h -l 50% "TMUX= tmux attach-session -t alpha:2"`,
      ]);

      resetCalls();

      await helper.cmdSplit("alpha:2", { lock: true, settleMs: 1 });

      expect(lockEvents).toEqual(["lock:start", "lock:end"]);
      expect(hostExecCalls).toEqual([
        `tmux display-message -p -t '%7' '#{pane_current_command}'`,
        `tmux split-window -t '%7' -h -l 50% "TMUX= tmux attach-session -t alpha:2"`,
      ]);

      resetCalls();
      paneCommandResponse = "claude";
      delete process.env.MAW_FORCE_SPLIT;
      process.env.MAW_ALLOW_CLAUDE_SPLIT = "1";

      await helper.cmdSplit("alpha:2");

      expect(hostExecCalls).toEqual([
        `tmux display-message -p -t '%7' '#{pane_current_command}'`,
        `tmux split-window -t '%7' -h -l 50% "TMUX= tmux attach-session -t alpha:2"`,
      ]);
    });

    test("wraps host exec failures with split context", async () => {
      hostExecFailure = "tmux refused";

      await expect(helper.cmdSplit("alpha:2")).rejects.toThrow("split failed: tmux refused");

      expect(hostExecCalls).toEqual([
        `tmux display-message -p -t '%7' '#{pane_current_command}'`,
        `tmux split-window -t '%7' -h -l 50% "TMUX= tmux attach-session -t alpha:2"`,
      ]);
    });

    test("defaults Claude-like source panes to a background tab", async () => {
      paneCommandResponse = "claude";
      anchorSessionResponse = "caller";
      clientTtyResponse = "/dev/ttys001";

      await helper.cmdSplit("alpha:2");

      expect(hostExecCalls).toEqual([
        `tmux display-message -p -t '%7' '#{pane_current_command}'`,
        `tmux display-message -p -t '%7' '#{session_name}'`,
        `tmux send-keys -R -t '%7' C-l`,
        `tmux clear-history -t '%7'`,
        `tmux display-message -p -t '%7' '#{client_tty}'`,
        `tmux refresh-client -c -t '/dev/ttys001'`,
        `tmux refresh-client -S -t '/dev/ttys001'`,
        hostExecCalls[7]!,
        `tmux send-keys -R -t '@42' C-l`,
        `tmux clear-history -t '@42'`,
        `tmux send-keys -R -t '%7' C-l`,
        `tmux clear-history -t '%7'`,
        `tmux display-message -p -t '%7' '#{client_tty}'`,
        `tmux refresh-client -c -t '/dev/ttys001'`,
        `tmux refresh-client -S -t '/dev/ttys001'`,
      ]);
      expect(hostExecCalls[7]).toContain(`tmux new-window -P -F '#{window_id}' -d -t 'caller:' -n 'split-2'`);
      expect(hostExecCalls[7]).toContain("printf");
      expect(hostExecCalls[7]).toContain("clear 2>/dev/null");
      expect(hostExecCalls[7]).toContain("exec tmux attach-session -t");
      expect(stdout()).toContain("opened background tab — alpha:2");
    });

    test("honors explicit Claude pane split policy and MAW_FORCE_SPLIT", async () => {
      paneCommandResponse = "claude";

      await helper.cmdSplit("alpha:2", { claudePanePolicy: "split" });

      expect(hostExecCalls).toEqual([
        `tmux display-message -p -t '%7' '#{pane_current_command}'`,
        `tmux split-window -t '%7' -h -l 50% "TMUX= tmux attach-session -t alpha:2"`,
      ]);

      resetCalls();
      paneCommandResponse = "claude";
      process.env.MAW_FORCE_SPLIT = "1";

      await helper.cmdSplit("alpha:2");

      expect(hostExecCalls).toEqual([
        `tmux display-message -p -t '%7' '#{pane_current_command}'`,
        `tmux split-window -t '%7' -h -l 50% "TMUX= tmux attach-session -t alpha:2"`,
      ]);
    });

    test("links a target window into the source session for Claude link-window policy", async () => {
      paneCommandResponse = "claude";
      anchorSessionResponse = "caller";
      clientTtyResponse = "/dev/ttys002";

      await helper.cmdSplit("alpha:2", { claudePanePolicy: "link-window" });

      expect(hostExecCalls).toEqual([
        `tmux display-message -p -t '%7' '#{pane_current_command}'`,
        `tmux display-message -p -t '%7' '#{session_name}'`,
        `tmux link-window -d -s 'alpha:2' -t 'caller:'`,
        `tmux display-message -p -t '%7' '#{client_tty}'`,
        `tmux refresh-client -c -t '/dev/ttys002'`,
        `tmux refresh-client -S -t '/dev/ttys002'`,
      ]);
      expect(stdout()).toContain("linked background tab — alpha:2");
    });

    test("falls back when optional background-tab probes cannot be read", async () => {
      paneCommandResponse = "claude";
      hostExecFailureNeedles = ["#{session_name}"];

      await helper.cmdSplit("alpha:2");

      expect(hostExecCalls).toEqual([
        `tmux display-message -p -t '%7' '#{pane_current_command}'`,
        `tmux display-message -p -t '%7' '#{session_name}'`,
        `tmux send-keys -R -t '%7' C-l`,
        `tmux clear-history -t '%7'`,
        `tmux display-message -p -t '%7' '#{client_tty}'`,
        "tmux refresh-client -c",
        "tmux refresh-client -S",
        hostExecCalls[7]!,
        `tmux send-keys -R -t '@42' C-l`,
        `tmux clear-history -t '@42'`,
        `tmux send-keys -R -t '%7' C-l`,
        `tmux clear-history -t '%7'`,
        `tmux display-message -p -t '%7' '#{client_tty}'`,
        "tmux refresh-client -c",
        "tmux refresh-client -S",
      ]);
      expect(hostExecCalls[7]).toContain(`tmux new-window -P -F '#{window_id}' -d -n 'split-2'`);
      expect(hostExecCalls[7]).toContain("clear 2>/dev/null");
    });

    test("link-window policy requires a readable source session", async () => {
      paneCommandResponse = "claude";

      await expect(helper.cmdSplit("alpha:2", { claudePanePolicy: "link-window" })).rejects.toThrow(
        "split failed: link-window policy requires an anchor pane with a tmux session",
      );

      expect(hostExecCalls).toEqual([
        `tmux display-message -p -t '%7' '#{pane_current_command}'`,
        `tmux display-message -p -t '%7' '#{session_name}'`,
      ]);
    });

    test("refuses or rejects invalid Claude pane policies without attaching", async () => {
      paneCommandResponse = "claude";

      await expect(helper.cmdSplit("alpha:2", { claudePanePolicy: "refuse" })).rejects.toThrow(
        "split failed: refusing to split from Claude-like pane '%7'",
      );

      expect(hostExecCalls).toEqual([
        `tmux display-message -p -t '%7' '#{pane_current_command}'`,
      ]);

      resetCalls();

      await expect(helper.cmdSplit("alpha:2", { claudePanePolicy: "bogus" })).rejects.toThrow(
        "--claude-pane-policy must be one of:",
      );
      expect(hostExecCalls).toEqual([]);
    });
  });
}
