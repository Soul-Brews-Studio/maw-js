import { describe, test, expect } from "bun:test";
import { buildTargets, mirrorCmd, paneTitle, pickLayout, chunkTargets, PANES_PER_PAGE } from "../src/overview";
import type { Session } from "../src/ssh";

const MOCK_SESSIONS: Session[] = [
  {
    name: "1-neo",
    windows: [
      { index: 1, name: "claude", active: true },
      { index: 2, name: "editor", active: false },
    ],
  },
  {
    name: "2-hermes",
    windows: [
      { index: 1, name: "claude", active: false },
      { index: 2, name: "shell", active: true },
    ],
  },
  {
    name: "3-pulse",
    windows: [{ index: 1, name: "claude", active: true }],
  },
  {
    name: "0-overview",
    windows: [{ index: 1, name: "war-room", active: true }],
  },
  {
    name: "scratch",
    windows: [{ index: 1, name: "misc", active: true }],
  },
];

describe("buildTargets", () => {
  test("finds all numbered sessions except 0-overview", () => {
    const targets = buildTargets(MOCK_SESSIONS, []);
    expect(targets).toHaveLength(3);
    expect(targets.map(t => t.oracle)).toEqual(["neo", "hermes", "pulse"]);
  });

  test("excludes 0-overview session", () => {
    const targets = buildTargets(MOCK_SESSIONS, []);
    expect(targets.find(t => t.oracle === "overview")).toBeUndefined();
  });

  test("excludes non-numbered sessions", () => {
    const targets = buildTargets(MOCK_SESSIONS, []);
    expect(targets.find(t => t.session === "scratch")).toBeUndefined();
  });

  test("picks active window index and name", () => {
    const targets = buildTargets(MOCK_SESSIONS, []);
    expect(targets.find(t => t.oracle === "neo")!.window).toBe(1);
    expect(targets.find(t => t.oracle === "neo")!.windowName).toBe("claude");
    expect(targets.find(t => t.oracle === "hermes")!.window).toBe(2);
    expect(targets.find(t => t.oracle === "hermes")!.windowName).toBe("shell");
  });

  test("strips number prefix for oracle name", () => {
    const targets = buildTargets(MOCK_SESSIONS, []);
    expect(targets[0].oracle).toBe("neo");
    expect(targets[0].session).toBe("1-neo");
  });

  test("filters by oracle name", () => {
    const targets = buildTargets(MOCK_SESSIONS, ["neo"]);
    expect(targets).toHaveLength(1);
    expect(targets[0].oracle).toBe("neo");
  });

  test("filters by partial oracle name", () => {
    const targets = buildTargets(MOCK_SESSIONS, ["her"]);
    expect(targets).toHaveLength(1);
    expect(targets[0].oracle).toBe("hermes");
  });

  test("filters by session name", () => {
    const targets = buildTargets(MOCK_SESSIONS, ["1-neo"]);
    expect(targets).toHaveLength(1);
    expect(targets[0].oracle).toBe("neo");
  });

  test("multiple filters are OR'd", () => {
    const targets = buildTargets(MOCK_SESSIONS, ["neo", "pulse"]);
    expect(targets).toHaveLength(2);
    expect(targets.map(t => t.oracle)).toEqual(["neo", "pulse"]);
  });

  test("no match returns empty", () => {
    const targets = buildTargets(MOCK_SESSIONS, ["nonexistent"]);
    expect(targets).toHaveLength(0);
  });

  test("handles session with no active window", () => {
    const sessions: Session[] = [
      {
        name: "5-volt",
        windows: [
          { index: 1, name: "shell", active: false },
          { index: 2, name: "editor", active: false },
        ],
      },
    ];
    const targets = buildTargets(sessions, []);
    expect(targets[0].window).toBe(1);
  });

  test("handles session with no windows", () => {
    const sessions: Session[] = [
      { name: "5-volt", windows: [] },
    ];
    const targets = buildTargets(sessions, []);
    expect(targets[0].window).toBe(1);
  });
});

describe("paneTitle", () => {
  test("formats oracle name and target", () => {
    const title = paneTitle({ session: "1-neo", window: 1, windowName: "neo-oracle", oracle: "neo" });
    expect(title).toBe("neo (1-neo:1)");
  });
});

describe("mirrorCmd", () => {
  test("uses watch --color for flicker-free ANSI display", () => {
    const cmd = mirrorCmd({ session: "2-hermes", window: 2, windowName: "hermes-oracle", oracle: "hermes" });
    expect(cmd).toContain("watch --color -t -n0.5");
    expect(cmd).toContain("tmux capture-pane");
  });

  test("does not echo input (watch handles this)", () => {
    const cmd = mirrorCmd({ session: "1-neo", window: 1, windowName: "neo-oracle", oracle: "neo" });
    expect(cmd).toMatch(/^watch /);
  });
});

describe("pickLayout", () => {
  test("uses even-horizontal for 1-2 targets", () => {
    expect(pickLayout(1)).toBe("even-horizontal");
    expect(pickLayout(2)).toBe("even-horizontal");
  });

  test("uses tiled for 3+ targets", () => {
    expect(pickLayout(3)).toBe("tiled");
    expect(pickLayout(4)).toBe("tiled");
  });
});

describe("chunkTargets", () => {
  test("returns single page when under limit", () => {
    const targets = buildTargets(MOCK_SESSIONS, []);
    const pages = chunkTargets(targets);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(3);
  });

  test("splits into multiple pages at PANES_PER_PAGE", () => {
    const sessions: Session[] = Array.from({ length: 8 }, (_, i) => ({
      name: `${i + 1}-oracle${i}`,
      windows: [{ index: 1, name: `win${i}`, active: true }],
    }));
    const targets = buildTargets(sessions, []);
    const pages = chunkTargets(targets);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(PANES_PER_PAGE);
    expect(pages[1]).toHaveLength(8 - PANES_PER_PAGE);
  });

  test("handles exact multiple of page size", () => {
    const sessions: Session[] = Array.from({ length: PANES_PER_PAGE }, (_, i) => ({
      name: `${i + 1}-oracle${i}`,
      windows: [{ index: 1, name: `win${i}`, active: true }],
    }));
    const targets = buildTargets(sessions, []);
    const pages = chunkTargets(targets);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(PANES_PER_PAGE);
  });

  test("handles empty targets", () => {
    const pages = chunkTargets([]);
    expect(pages).toHaveLength(0);
  });
});

describe("argument parsing", () => {
  test("separates flags from filter args", () => {
    const filterArgs = ["neo", "--kill", "hermes", "-k"];
    const kill = filterArgs.includes("--kill") || filterArgs.includes("-k");
    const filters = filterArgs.filter(a => !a.startsWith("-"));
    expect(kill).toBe(true);
    expect(filters).toEqual(["neo", "hermes"]);
  });

  test("no flags means no kill", () => {
    const filterArgs = ["neo", "hermes"];
    const kill = filterArgs.includes("--kill") || filterArgs.includes("-k");
    expect(kill).toBe(false);
  });

  test("empty args", () => {
    const filterArgs: string[] = [];
    const kill = filterArgs.includes("--kill") || filterArgs.includes("-k");
    const filters = filterArgs.filter(a => !a.startsWith("-"));
    expect(kill).toBe(false);
    expect(filters).toEqual([]);
  });
});
