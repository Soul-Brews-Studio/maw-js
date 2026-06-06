import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "..");

type Pane = { id: string; target: string; command?: string; title?: string; lastActivity?: number };

let panes: Pane[] = [];
let captures = new Map<string, string>();

mock.module("os", () => ({ homedir: () => "/mock-home" }));

mock.module(join(srcRoot, "src/sdk"), () => ({
  tmux: {
    listPanes: async () => panes,
    capture: async (target: string) => captures.get(target) ?? "",
  },
  tmuxCmd: () => "tmux",
  hostExec: async () => "",
}));

mock.module(join(srcRoot, "src/commands/shared/fleet-load"), () => ({
  loadFleetEntries: () => [{ file: "101-mawjs.json" }],
}));

mock.module(join(srcRoot, "src/core/fleet/worktrees-scan"), () => ({ scanWorktrees: async () => [] }));
mock.module(join(srcRoot, "src/core/ghq"), () => ({ ghqList: async () => [], ghqListSync: () => [] }));

const { classifyLsPaneActivity, cmdTmuxLs, paneActivityJson } = await import("../src/commands/plugins/tmux/impl");

const original = { log: console.log, now: Date.now };

async function captureJson(fn: () => Promise<void>) {
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try { await fn(); } finally { console.log = original.log; }
  return JSON.parse(logs.join("\n"));
}

beforeEach(() => {
  panes = [];
  captures = new Map();
  Date.now = () => 1_700_000_000_000;
});

afterEach(() => {
  Date.now = original.now;
  console.log = original.log;
});

describe("maw ls --json activity classification (#1992)", () => {
  test("maps pane age status to busy, idle, and unknown activity fields", async () => {
    const now = Math.floor(Date.now() / 1000);
    panes = [
      { id: "%1", target: "101-mawjs:main.0", command: "claude", lastActivity: now - 5 },
      { id: "%2", target: "101-mawjs:main.1", command: "zsh", lastActivity: now - 90 },
      { id: "%3", target: "101-mawjs:main.2", command: "zsh" },
    ];

    const rows = await captureJson(() => cmdTmuxLs({ all: true, json: true }));

    expect(rows.map((row: any) => [row.id, row.activity, row.activitySource, row.activityWindow])).toEqual([
      ["%1", "busy", "tmux-window-activity", "30s"],
      ["%2", "idle", "tmux-window-activity", "30s"],
      ["%3", "unknown", "unknown", "30s"],
    ]);
  });

  test("classifies context-limited agent panes as stuck", async () => {
    const now = Math.floor(Date.now() / 1000);
    panes = [{ id: "%4", target: "101-mawjs:main.3", command: "claude", lastActivity: now - 2 }];
    captures.set("101-mawjs:main.3", "Context limit reached. /compact or /clear to continue");

    const rows = await captureJson(() => cmdTmuxLs({ all: true, json: true }));

    expect(rows[0]).toMatchObject({ status: "frozen", activity: "stuck", activitySource: "context-limit" });
  });

  test("exports the pure classifier for API stability", () => {
    expect(classifyLsPaneActivity("frozen")).toBe("stuck");
    expect(paneActivityJson({ status: "stale" })).toEqual({
      activity: "idle",
      activitySource: "tmux-window-activity",
      activityWindow: "30s",
    });
  });
});
