import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");

type MockPane = {
  id: string;
  target: string;
  command?: string;
  title?: string;
  lastActivity?: number;
};

let panes: MockPane[] = [];
let sessionCreatedRaw = "";
let sessionActivityRaw = "";
let captureByTarget = new Map<string, string>();

mock.module(join(srcRoot, "src/sdk"), () => ({
  tmux: {
    listPanes: async () => panes,
    capture: async (target: string) => captureByTarget.get(target) ?? "",
  },
  hostExec: async (cmd: string) => {
    if (cmd.includes("list-sessions") && cmd.includes("session_created")) return sessionCreatedRaw;
    if (cmd.includes("list-sessions") && cmd.includes("session_activity")) return sessionActivityRaw;
    if (cmd.includes("display-message") && cmd.includes("session_name")) return "old-session\n";
    return "";
  },
  tmuxCmd: () => "tmux",
}));

mock.module(join(srcRoot, "src/commands/shared/fleet-load"), () => ({
  loadFleetEntries: () => [],
}));

mock.module(join(srcRoot, "src/core/fleet/worktrees-scan"), () => ({
  scanWorktrees: async () => [],
}));

mock.module(join(srcRoot, "src/core/ghq"), () => ({
  ghqList: async () => [],
  ghqListSync: () => [],
}));

const {
  activeDurationArg,
  cmdTmuxLs,
  formatSessionCreated,
  parseActiveDurationSeconds,
  parseSessionActivityList,
  parseSessionCreatedList,
} = await import("../../src/commands/plugins/tmux/impl");

const origLog = console.log;
let outs: string[] = [];

async function capture(fn: () => Promise<void>) {
  outs = [];
  console.log = (...args: unknown[]) => outs.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = origLog;
  }
  return outs.join("\n");
}

beforeEach(() => {
  const now = Math.floor(Date.now() / 1000);
  panes = [
    { id: "%1", target: "old-session:oracle.0", command: "claude", title: "old", lastActivity: now },
    { id: "%2", target: "new-session:oracle.0", command: "claude", title: "new", lastActivity: now },
    { id: "%3", target: "mid-session:oracle.0", command: "zsh", title: "mid", lastActivity: now },
  ];
  sessionCreatedRaw = "old-session\t100\nnew-session\t300\nmid-session\t200\n";
  sessionActivityRaw = [
    `old-session\t${now - 3600}`,
    `new-session\t${now - 60}`,
    `mid-session\t${now - 1200}`,
  ].join("\n");
  captureByTarget = new Map();
});

describe("maw ls --recent (#1628)", () => {
  test("parses and formats tmux session_created epochs", () => {
    expect([...parseSessionCreatedList(sessionCreatedRaw).entries()]).toEqual([
      ["old-session", 100],
      ["new-session", 300],
      ["mid-session", 200],
    ]);
    expect(formatSessionCreated(undefined)).toBe("—");
    expect(formatSessionCreated(300)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:05:00$/);
    expect([...parseSessionActivityList(sessionActivityRaw).keys()]).toEqual(["old-session", "new-session", "mid-session"]);
    expect(parseActiveDurationSeconds("30m")).toBe(1800);
    expect(parseActiveDurationSeconds("1h")).toBe(3600);
    expect(parseActiveDurationSeconds("2d")).toBe(172800);
    expect(parseActiveDurationSeconds("45")).toBe(2700);
    expect(activeDurationArg(["--active", "1h"])).toBe("1h");
    expect(activeDurationArg(["--active=2d"])).toBe("2d");
    expect(activeDurationArg(["--active", "session-filter"])).toBeUndefined();
  });

  test("compact recent view sorts sessions newest-first and honors limit", async () => {
    const out = await capture(() => cmdTmuxLs({ all: true, compact: true, recent: true, recentLimit: 2 }));

    expect(out).toContain("CREATED");
    expect(out.indexOf("new-session")).toBeLessThan(out.indexOf("mid-session"));
    expect(out).not.toContain("old-session");
  });

  test("verbose recent view keeps panes grouped by newest session", async () => {
    const out = await capture(() => cmdTmuxLs({ all: true, verbose: true, recent: true }));

    expect(out).toContain("CREATED");
    expect(out.indexOf("new-session:oracle.0")).toBeLessThan(out.indexOf("mid-session:oracle.0"));
    expect(out.indexOf("mid-session:oracle.0")).toBeLessThan(out.indexOf("old-session:oracle.0"));
  });

  test("marks context-limit panes and sessions with warning status", async () => {
    captureByTarget.set("new-session:oracle.0", "Context limit reached · /compact or /clear to continue");

    const compact = await capture(() => cmdTmuxLs({ all: true, compact: true }));
    expect(compact).toContain("⚠");
    expect(compact).toContain("new-session");
    expect(compact).toContain("new-session:oracle.0 context-limit");

    const verbose = await capture(() => cmdTmuxLs({ all: true, verbose: true }));
    expect(verbose).toContain("new-session:oracle.0");
    expect(verbose).toContain("context-limit");
  });

  test("empty active view formats duration thresholds", async () => {
    const now = Math.floor(Date.now() / 1000);
    sessionActivityRaw = [
      `old-session	${now - 864000}`,
      `new-session	${now - 864000}`,
      `mid-session	${now - 864000}`,
    ].join("\n");

    expect(await capture(() => cmdTmuxLs({ all: true, compact: true, active: true, activeThresholdSec: 45 }))).toContain("last 45s");
    expect(await capture(() => cmdTmuxLs({ all: true, compact: true, active: true, activeThresholdSec: 1800 }))).toContain("last 30m");
    expect(await capture(() => cmdTmuxLs({ all: true, compact: true, active: true, activeThresholdSec: 3600 }))).toContain("last 1h");
    expect(await capture(() => cmdTmuxLs({ all: true, compact: true, active: true, activeThresholdSec: 86400 }))).toContain("last 1d");
  });

  test("active view filters by tmux session_activity and supports threshold overrides", async () => {
    const defaultActive = await capture(() => cmdTmuxLs({ all: true, compact: true, active: true }));
    expect(defaultActive).toContain("new-session");
    expect(defaultActive).toContain("mid-session");
    expect(defaultActive).not.toContain("old-session");
    expect(defaultActive).toContain("last ");

    const oneHour = await capture(() => cmdTmuxLs({ all: true, compact: true, active: true, activeThresholdSec: 3600 }));
    expect(oneHour).toContain("old-session");

    const newestActive = await capture(() => cmdTmuxLs({ all: true, compact: true, recent: true, recentLimit: 1, active: true }));
    expect(newestActive).toContain("new-session");
    expect(newestActive).not.toContain("mid-session");
    expect(newestActive).not.toContain("old-session");
  });
});
