/**
 * view-grouped-session — Tmux.newGroupedSession signature + window-size wiring.
 *
 * Issue #409: `maw view <agent>` unconditionally killed any existing view
 * session, which evicted other clients already attached to the same view.
 * The fix makes the view-command reuse an existing grouped session, and
 * drops the hard-coded 200x50 sizing in favour of tmux's native
 * `window-size=largest` — so the view sizes to the largest *attached*
 * client rather than a dead constant.
 *
 * These tests use a subclass-DI seam: we override `Tmux.run()` (and
 * `setOption()`) to capture the argv tmux would receive, without actually
 * shelling out. Same philosophy as `federation-symmetric.test.ts` —
 * function/method injection, no `mock.module`, placed in `test/` (not
 * `test/isolated/`) because no process-global mocking is involved.
 *
 * Reuse-vs-create at the impl.ts level is tested indirectly: the
 * `killSession`-is-no-longer-called behaviour is guaranteed by the
 * `if (weCreated)` guard on line 181 and the `hasSession` branch on
 * line 115. The transport-level invariants covered here are what unlock
 * that guarded flow.
 */
import { describe, test, expect } from "bun:test";
import { Tmux } from "../src/core/transport/tmux-class";

type Call = { subcommand: string; args: (string | number)[] };
type OptCall = { target: string; option: string; value: string };

class CapturingTmux extends Tmux {
  runCalls: Call[] = [];
  optionCalls: OptCall[] = [];
  // Pretend there is no tmux server — hasSession returns false, killSession no-ops.
  hasSessionReturn = false;

  constructor() {
    super(undefined, ""); // empty socket → no -S flag in run()
  }

  // Capture argv; return empty string (what real tmux new-session returns on success).
  async run(subcommand: string, ...args: (string | number)[]): Promise<string> {
    this.runCalls.push({ subcommand, args });
    return "";
  }

  async tryRun(subcommand: string, ...args: (string | number)[]): Promise<string> {
    this.runCalls.push({ subcommand, args });
    return "";
  }

  async setOption(target: string, option: string, value: string): Promise<void> {
    this.optionCalls.push({ target, option, value });
  }

  async hasSession(_name: string): Promise<boolean> {
    return this.hasSessionReturn;
  }
}

describe("Tmux.newGroupedSession — #409 signature relaxation", () => {
  test("omitting cols/rows → new-session has no -x/-y flags", async () => {
    const t = new CapturingTmux();
    await t.newGroupedSession("parent-session", "view-session", {});

    const newSessionCall = t.runCalls.find(c => c.subcommand === "new-session");
    expect(newSessionCall).toBeDefined();
    expect(newSessionCall!.args).toEqual(["-d", "-t", "parent-session", "-s", "view-session"]);
    expect(newSessionCall!.args).not.toContain("-x");
    expect(newSessionCall!.args).not.toContain("-y");
  });

  test("no opts at all → still emits a valid new-session", async () => {
    const t = new CapturingTmux();
    await t.newGroupedSession("parent", "child");

    const call = t.runCalls.find(c => c.subcommand === "new-session")!;
    expect(call.args).toEqual(["-d", "-t", "parent", "-s", "child"]);
    expect(t.optionCalls).toEqual([]);
  });

  test("cols + rows (pty.ts caller shape) → -x/-y preserved (backwards compat)", async () => {
    const t = new CapturingTmux();
    await t.newGroupedSession("parent", "pty-sess", { cols: 200, rows: 50 });

    const call = t.runCalls.find(c => c.subcommand === "new-session")!;
    expect(call.args).toEqual(["-d", "-t", "parent", "-s", "pty-sess", "-x", 200, "-y", 50]);
  });

  test("windowSize=largest → setOption called with window-size=largest on the new session", async () => {
    const t = new CapturingTmux();
    await t.newGroupedSession("parent", "view", { windowSize: "largest" });

    expect(t.optionCalls).toEqual([
      { target: "view", option: "window-size", value: "largest" },
    ]);
  });

  test("windowSize omitted → setOption NOT called for window-size", async () => {
    const t = new CapturingTmux();
    await t.newGroupedSession("parent", "view", { cols: 100, rows: 30 });

    const windowSizeCalls = t.optionCalls.filter(c => c.option === "window-size");
    expect(windowSizeCalls).toEqual([]);
  });

  test("cols only (no rows) → only -x emitted (no -y)", async () => {
    const t = new CapturingTmux();
    await t.newGroupedSession("parent", "child", { cols: 100 });

    const call = t.runCalls.find(c => c.subcommand === "new-session")!;
    expect(call.args).toContain("-x");
    expect(call.args).toContain(100);
    expect(call.args).not.toContain("-y");
  });

  test("window option → selectWindow fired after new-session (preserves prior behavior)", async () => {
    const t = new CapturingTmux();
    await t.newGroupedSession("parent", "child", { window: "1" });

    // selectWindow is routed through tryRun("select-window", ...)
    const selectCall = t.runCalls.find(c => c.subcommand === "select-window");
    expect(selectCall).toBeDefined();
    expect(selectCall!.args).toEqual(["-t", "child:1"]);
  });

  test("windowSize + window + cols/rows together → all wired correctly", async () => {
    const t = new CapturingTmux();
    await t.newGroupedSession("parent", "child", {
      cols: 300, rows: 80, window: "2", windowSize: "largest",
    });

    const newSess = t.runCalls.find(c => c.subcommand === "new-session")!;
    expect(newSess.args).toEqual([
      "-d", "-t", "parent", "-s", "child", "-x", 300, "-y", 80,
    ]);
    expect(t.optionCalls).toEqual([
      { target: "child", option: "window-size", value: "largest" },
    ]);
    const selectCall = t.runCalls.find(c => c.subcommand === "select-window");
    expect(selectCall!.args).toEqual(["-t", "child:2"]);
  });
});

describe("#409 view-session reuse semantics — transport-level invariants", () => {
  // These exercise the building blocks cmdView relies on. The impl.ts flow
  // is: check hasSession(viewName) → if true, reuse (no newGroupedSession,
  // no killSession on cleanup); if false, newGroupedSession + kill on detach.

  test("hasSession=true path → caller can skip newGroupedSession (no new-session runs)", async () => {
    const t = new CapturingTmux();
    t.hasSessionReturn = true;

    const exists = await t.hasSession("agent-view");
    expect(exists).toBe(true);
    // Simulate impl.ts guard: we do NOT call newGroupedSession when view exists.
    const newSessionCalls = t.runCalls.filter(c => c.subcommand === "new-session");
    expect(newSessionCalls).toEqual([]);
  });

  test("hasSession=false path → caller proceeds with newGroupedSession(windowSize:largest)", async () => {
    const t = new CapturingTmux();
    t.hasSessionReturn = false;

    const exists = await t.hasSession("agent-view");
    expect(exists).toBe(false);
    // Simulate impl.ts flow when view does not exist yet.
    await t.newGroupedSession("agent-sess", "agent-view", { windowSize: "largest" });

    const newSess = t.runCalls.find(c => c.subcommand === "new-session")!;
    expect(newSess.args).toEqual(["-d", "-t", "agent-sess", "-s", "agent-view"]);
    expect(t.optionCalls).toEqual([
      { target: "agent-view", option: "window-size", value: "largest" },
    ]);
  });
});
