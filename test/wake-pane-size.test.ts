import { describe, test, expect, mock, beforeEach } from "bun:test";

// Replicate the helper logic inline against a mock tmux to avoid pulling
// the full sdk module chain (config/ghq-root/etc) into the test runner.
// The real impl lives in src/commands/shared/wake-pane-size.ts; if it
// drifts from this replica, update both.

const CLAUDE_COLS = 200;
const CLAUDE_ROWS = 50;

interface FakeTmux {
  calls: Array<[string, ...unknown[]]>;
  setOption: (target: string, opt: string, val: string) => Promise<void>;
  setEnvironment: (session: string, key: string, val: string) => Promise<void>;
  resizeWindow: (target: string, cols: number, rows: number) => Promise<void>;
}

function fakeTmux(): FakeTmux {
  const calls: FakeTmux["calls"] = [];
  return {
    calls,
    setOption: async (t, o, v) => { calls.push(["setOption", t, o, v]); },
    setEnvironment: async (s, k, v) => { calls.push(["setEnvironment", s, k, v]); },
    resizeWindow: async (t, c, r) => { calls.push(["resizeWindow", t, c, r]); },
  };
}

async function pinSessionWide(t: FakeTmux, session: string) {
  await t.setOption(session, "window-size", "manual");
  await t.setEnvironment(session, "COLUMNS", String(CLAUDE_COLS));
  await t.setEnvironment(session, "LINES", String(CLAUDE_ROWS));
  await t.resizeWindow(session, CLAUDE_COLS, CLAUDE_ROWS);
}

async function pinWindowWide(t: FakeTmux, target: string) {
  await t.resizeWindow(target, CLAUDE_COLS, CLAUDE_ROWS);
}

describe("wake-pane-size", () => {
  test("pinSessionWide pins window-size manual + COLUMNS/LINES + resize-window", async () => {
    const t = fakeTmux();
    await pinSessionWide(t, "02-neo");
    expect(t.calls).toEqual([
      ["setOption", "02-neo", "window-size", "manual"],
      ["setEnvironment", "02-neo", "COLUMNS", "200"],
      ["setEnvironment", "02-neo", "LINES", "50"],
      ["resizeWindow", "02-neo", 200, 50],
    ]);
  });

  test("pinWindowWide resizes a single window target", async () => {
    const t = fakeTmux();
    await pinWindowWide(t, "02-neo:neo-oracle");
    expect(t.calls).toEqual([
      ["resizeWindow", "02-neo:neo-oracle", 200, 50],
    ]);
  });

  test("pinSessionWide setEnvironment fires BEFORE resizeWindow so the shell's WINCH inherits the new size", async () => {
    // Order matters: window-size manual first (so attaching clients don't
    // shrink the session), then env (so any tmux-spawned children inherit),
    // then resize-window (which triggers SIGWINCH on existing shells).
    const t = fakeTmux();
    await pinSessionWide(t, "s");
    const ops = t.calls.map(c => c[0]);
    expect(ops.indexOf("setOption")).toBeLessThan(ops.indexOf("resizeWindow"));
    expect(ops.indexOf("setEnvironment")).toBeLessThan(ops.indexOf("resizeWindow"));
  });
});
