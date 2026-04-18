/**
 * split-anchor.test.ts — #545 cmdSplit anchorPane contract.
 *
 * Covers src/commands/plugins/split/impl.ts:
 *   - opts.anchorPane set → tmux command emits `-t '<anchorPane>'`
 *   - opts.anchorPane unset + $TMUX_PANE set → `-t '<env pane>'`
 *   - opts.anchorPane precedence over $TMUX_PANE
 *   - single-quote safe escaping in anchorPane value
 *   - trailing log line appends "(anchored at <anchorPane>)" when set
 *
 * Mocked seams: src/sdk (hostExec, listSessions, withPaneLock).
 */
import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { join } from "path";

// ─── Command capture via hostExec mock ───────────────────────────────────────

let hostExecCalls: string[] = [];

mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return "";
  },
  listSessions: async () => [],
  withPaneLock: async (fn: () => Promise<void>) => fn(),
  // Re-export stubs for symbols imported by sibling modules that may load
  // in the same bun-test process — mock.module is process-wide, so missing
  // exports here surface as "Export named X not found" when cmdView's test
  // file is loaded after this one.
  tmuxCmd: () => "tmux",
  resolveSocket: () => undefined,
  Tmux: class TmuxStub {
    async hasSession(_n: string) { return false; }
    async newGroupedSession(_p: string, _n: string, _o?: unknown) {}
    async selectWindow(_t: string) {}
    async set(_t: string, _o: string, _v: string) {}
    async switchClient(_t: string) {}
    async killSession(_t: string) {}
  },
}));

const { cmdSplit } = await import("../../src/commands/plugins/split/impl");

// ─── Harness: env + console.log capture ──────────────────────────────────────

const origLog = console.log;
let logs: string[] = [];
let savedTmux: string | undefined;
let savedPane: string | undefined;

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function captureLogs() {
  logs = [];
  console.log = (...a: unknown[]) => {
    logs.push(stripAnsi(a.map((x) => (typeof x === "string" ? x : String(x))).join(" ")));
  };
}

beforeEach(() => {
  savedTmux = process.env.TMUX;
  savedPane = process.env.TMUX_PANE;
  process.env.TMUX = "/tmp/tmux-test";
  delete process.env.TMUX_PANE;
  hostExecCalls = [];
  captureLogs();
});

afterEach(() => {
  console.log = origLog;
  if (savedTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = savedTmux;
  if (savedPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = savedPane;
});

afterAll(() => {
  console.log = origLog;
});

// ─── cmdSplit anchorPane (#545) ──────────────────────────────────────────────

describe("cmdSplit anchorPane (#545)", () => {
  test("opts.anchorPane set → tmux -t '<pane>' in the split-window command", async () => {
    await cmdSplit("session:0", { anchorPane: "%12" });
    expect(hostExecCalls.length).toBe(1);
    expect(hostExecCalls[0]).toContain(`-t '%12'`);
    expect(hostExecCalls[0]).toContain("split-window");
  });

  test("no anchorPane + TMUX_PANE set → -t '<env pane>'", async () => {
    process.env.TMUX_PANE = "%5";
    await cmdSplit("session:0", {});
    expect(hostExecCalls.length).toBe(1);
    expect(hostExecCalls[0]).toContain(`-t '%5'`);
  });

  test("opts.anchorPane takes precedence over $TMUX_PANE", async () => {
    process.env.TMUX_PANE = "%99";
    await cmdSplit("session:0", { anchorPane: "%12" });
    expect(hostExecCalls.length).toBe(1);
    expect(hostExecCalls[0]).toContain(`-t '%12'`);
    expect(hostExecCalls[0]).not.toContain(`-t '%99'`);
  });

  test("no anchorPane + no TMUX_PANE → no -t flag (pre-#545 fallback)", async () => {
    // TMUX_PANE cleared in beforeEach.
    await cmdSplit("session:0", {});
    expect(hostExecCalls.length).toBe(1);
    // The command must not emit an empty -t '' or a -t flag of any kind.
    expect(hostExecCalls[0]).not.toMatch(/-t '/);
  });

  test("anchorPane with single quote is safely shell-escaped", async () => {
    // Canonical bash single-quote escape: ' → '\'' — split-window stays
    // well-formed and the whole -t value is single-quoted.
    await cmdSplit("session:0", { anchorPane: "weird'name" });
    expect(hostExecCalls.length).toBe(1);
    const cmd = hostExecCalls[0]!;
    // The -t value is wrapped in single quotes (with the inner ' escaped).
    expect(/ -t '.*' /.test(cmd)).toBe(true);
    // The literal `weird` part survives the escape round-trip.
    expect(cmd).toContain("weird");
    // No injection — the inner `'` is not left bare-free inside a single-quoted string.
    // bash escape contract: weird'\''name
    expect(cmd).toContain(String.raw`weird'\''name`);
  });

  test("log line appends ' (anchored at <anchorPane>)' when anchorPane set", async () => {
    await cmdSplit("session:0", { anchorPane: "%12" });
    const joined = logs.join("\n");
    expect(joined).toContain("(anchored at %12)");
  });

  test("log line does NOT include '(anchored at ...)' when anchorPane unset", async () => {
    process.env.TMUX_PANE = "%5";
    await cmdSplit("session:0", {});
    const joined = logs.join("\n");
    expect(joined).not.toContain("anchored at");
  });
});
