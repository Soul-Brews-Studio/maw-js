/** Targeted isolated coverage for src/vendor/mpr-plugins/overview/impl.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Session } from "../../src/sdk/index.ts";

type TmuxCall = { method: string; args: unknown[] };

let sessions: Session[] = [];
let calls: TmuxCall[] = [];
const config = { port: 4321 };
const originalLog = console.log;
const originalError = console.error;
let logs: string[] = [];
let errors: string[] = [];

function record(method: string, ...args: unknown[]) {
  calls.push({ method, args });
}

mock.module("maw-js/config", () => ({
  loadConfig: () => config,
}));

mock.module("maw-js/sdk", () => ({
  hostExec: mock(() => undefined),
  listSessions: mock(async () => sessions),
  tmux: {
    killSession: mock(async (...args: unknown[]) => record("killSession", ...args)),
    newSession: mock(async (...args: unknown[]) => record("newSession", ...args)),
    set: mock(async (...args: unknown[]) => record("set", ...args)),
    newWindow: mock(async (...args: unknown[]) => record("newWindow", ...args)),
    selectPane: mock(async (...args: unknown[]) => record("selectPane", ...args)),
    sendKeys: mock(async (...args: unknown[]) => record("sendKeys", ...args)),
    splitWindow: mock(async (...args: unknown[]) => record("splitWindow", ...args)),
    selectLayout: mock(async (...args: unknown[]) => record("selectLayout", ...args)),
    selectWindow: mock(async (...args: unknown[]) => record("selectWindow", ...args)),
  },
}));

const {
  PANES_PER_PAGE,
  buildTargets,
  chunkTargets,
  cmdOverview,
  mirrorCmd,
  paneColor,
  paneTitle,
  pickLayout,
  processMirror,
} = await import("../../src/vendor/mpr-plugins/overview/impl.ts?overview-impl-coverage");

function makeSession(name: string, windows: Array<{ index: number; name: string; active?: boolean }>): Session {
  return { name, windows } as Session;
}

beforeEach(() => {
  sessions = [];
  calls = [];
  logs = [];
  errors = [];
  config.port = 4321;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

describe("overview impl pure helpers", () => {
  test("buildTargets filters numbered oracle sessions and falls back for inactive/missing windows", () => {
    sessions = [
      makeSession("0-overview", [{ index: 1, name: "overview", active: true }]),
      makeSession("scratch", [{ index: 1, name: "scratch", active: true }]),
      makeSession("1-alpha", [
        { index: 1, name: "shell" },
        { index: 3, name: "work", active: true },
      ]),
      makeSession("2-beta", [{ index: 2, name: "fallback" }]),
      makeSession("3-gamma", []),
    ];

    expect(buildTargets(sessions, [])).toEqual([
      { session: "1-alpha", window: 3, windowName: "work", oracle: "alpha" },
      { session: "2-beta", window: 2, windowName: "fallback", oracle: "beta" },
      { session: "3-gamma", window: 1, windowName: "gamma", oracle: "gamma" },
    ]);
    expect(buildTargets(sessions, ["alp", "3-gam"])).toEqual([
      { session: "1-alpha", window: 3, windowName: "work", oracle: "alpha" },
      { session: "3-gamma", window: 1, windowName: "gamma", oracle: "gamma" },
    ]);
  });

  test("rendering helpers cover colors, titles, mirror command, layouts, chunks, and mirror text cleanup", () => {
    const target = { session: "10-red fox", window: 7, windowName: "main", oracle: "red fox" };
    expect(paneColor(0)).toBe("colour204");
    expect(paneColor(10)).toBe("colour204");
    expect(paneTitle(target)).toBe("red fox (10-red fox:7)");
    expect(mirrorCmd(target)).toContain("http://localhost:4321/api/mirror?target=10-red%20fox%3A7");
    expect(pickLayout(1)).toBe("even-horizontal");
    expect(pickLayout(2)).toBe("even-horizontal");
    expect(pickLayout(3)).toBe("tiled");

    const targets = Array.from({ length: PANES_PER_PAGE + 2 }, (_, i) => ({
      session: `${i + 1}-o${i}`,
      window: 1,
      windowName: `w${i}`,
      oracle: `o${i}`,
    }));
    expect(chunkTargets(targets).map(page => page.length)).toEqual([PANES_PER_PAGE, 2]);
    expect(processMirror("\nhead\n━━━━━━━\n\nlast\n", 4)).toBe("\nhead\n────────────────────────────────────────────────────────────\nlast");
    expect(processMirror("one\ntwo\nthree", 2)).toBe("two\nthree");
  });
});

describe("overview command", () => {
  test("kill flag only removes the overview session and reports completion", async () => {
    await cmdOverview(["--kill", "ignored-filter"]);

    expect(calls).toEqual([{ method: "killSession", args: ["0-overview"] }]);
    expect(logs.join("\n")).toContain("overview killed");
  });

  test("empty target set reports an error after cleanup", async () => {
    sessions = [makeSession("not-numbered", [{ index: 1, name: "main", active: true }])];

    await cmdOverview([]);

    expect(calls.map(c => c.method)).toEqual(["killSession"]);
    expect(errors.join("\n")).toContain("no oracle sessions found");
  });

  test("creates paged overview windows, pane titles, mirror commands, and final navigation hints", async () => {
    sessions = Array.from({ length: PANES_PER_PAGE + 1 }, (_, i) =>
      makeSession(`${i + 1}-oracle${i + 1}`, [{ index: i + 1, name: `win${i + 1}`, active: true }]),
    );

    await cmdOverview(["oracle"]);

    expect(calls[0]).toEqual({ method: "killSession", args: ["0-overview"] });
    expect(calls).toContainEqual({ method: "newSession", args: ["0-overview", { window: "page-1" }] });
    expect(calls).toContainEqual({ method: "newWindow", args: ["0-overview", "page-2"] });
    expect(calls.filter(c => c.method === "splitWindow")).toHaveLength(PANES_PER_PAGE - 1);
    expect(calls).toContainEqual({ method: "selectLayout", args: ["0-overview:page-1", "tiled"] });
    expect(calls).toContainEqual({ method: "selectLayout", args: ["0-overview:page-2", "even-horizontal"] });
    expect(calls).toContainEqual({ method: "selectWindow", args: ["0-overview:page-1"] });

    const firstTitle = calls.find(c => c.method === "selectPane" && c.args[0] === "0-overview:page-1.0");
    expect(firstTitle?.args[1]).toMatchObject({ title: expect.stringContaining("oracle1 (1-oracle1:1)") });
    const sendKeys = calls.filter(c => c.method === "sendKeys");
    expect(sendKeys).toHaveLength(PANES_PER_PAGE + 1);
    expect(String(sendKeys[0].args[1])).toContain("target=1-oracle1%3A1");

    const out = logs.join("\n");
    expect(out).toContain("overview: 10 oracles across 2 pages");
    expect(out).toContain("page-1: oracle1, oracle2");
    expect(out).toContain("page-2: oracle10");
    expect(out).toContain("navigate: Ctrl-b n/p");
  });
});
