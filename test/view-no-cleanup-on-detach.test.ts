/**
 * Regression tests for #420 — `maw a <agent>` must NOT clean up the
 * grouped view session on normal detach.
 *
 * #419 ("skip cleanup unless creator") still killed the view whenever the
 * creator was the sole viewer, which is the common case. As a result, the
 * next `maw a <agent>` paid the create cost every time instead of reusing
 * the grouped view.
 *
 * Fix: cmdView never auto-kills the view session. Cleanup is now the sole
 * responsibility of `maw cleanup --zombie-agents` (#400/#418) or an
 * explicit `tmux kill-session -t <viewName>`.
 *
 * Style matches view-grouped-session.test.ts: a CapturingTmux subclass
 * records argv-level calls, no process-global mocking, test/ (not
 * test/isolated/).
 */
import { describe, test, expect } from "bun:test";
import { Tmux } from "../src/core/transport/tmux-class";

type Call = { subcommand: string; args: (string | number)[] };

class CapturingTmux extends Tmux {
  runCalls: Call[] = [];
  killSessionCalls: string[] = [];
  hasSessionReturn = false;

  constructor() {
    super(undefined, "");
  }

  async run(subcommand: string, ...args: (string | number)[]): Promise<string> {
    this.runCalls.push({ subcommand, args });
    return "";
  }

  async tryRun(subcommand: string, ...args: (string | number)[]): Promise<string> {
    this.runCalls.push({ subcommand, args });
    return "";
  }

  async hasSession(_name: string): Promise<boolean> {
    return this.hasSessionReturn;
  }

  async killSession(name: string): Promise<void> {
    this.killSessionCalls.push(name);
  }

  async setOption(_t: string, _o: string, _v: string): Promise<void> {}
}

/**
 * Mirror of the cmdView cleanup decision post-#420. The function captures
 * the contract under test: after a normal attach+detach cycle, the view
 * session must remain alive regardless of whether the current caller was
 * the creator or a subsequent reuser.
 *
 * Before #420: `if (weCreated) await t.killSession(viewName);`
 * After  #420: `if (kill) await t.killSession(viewName);` — opt-in only.
 */
async function simulateDetachCleanup(
  t: CapturingTmux,
  viewName: string,
  kill: boolean,
): Promise<void> {
  if (kill) await t.killSession(viewName);
}

describe("#420 — grouped view session survives normal detach", () => {
  test("default detach (kill=false) → killSession NOT called (view reusable next time)", async () => {
    const t = new CapturingTmux();
    await simulateDetachCleanup(t, "mawjs-view", /* kill */ false);
    expect(t.killSessionCalls).toEqual([]);
  });

  test("full sequence: create-on-miss then detach → new-session ran, no kill-session", async () => {
    const t = new CapturingTmux();
    t.hasSessionReturn = false;

    // 1. hasSession says view doesn't exist → impl creates it
    const exists = await t.hasSession("mawjs-view");
    expect(exists).toBe(false);
    await t.newGroupedSession("101-mawjs", "mawjs-view", { windowSize: "largest" });

    // 2. attach happens (execSync — not modelled here)

    // 3. detach-cleanup path — must be a no-op by default post-#420
    await simulateDetachCleanup(t, "mawjs-view", /* kill */ false);

    // new-session should have been emitted once, kill-session never.
    const newSessionCalls = t.runCalls.filter(c => c.subcommand === "new-session");
    expect(newSessionCalls).toHaveLength(1);
    expect(t.killSessionCalls).toEqual([]);
  });

  test("full sequence: reuse-on-hit then detach → no new-session, no kill-session", async () => {
    const t = new CapturingTmux();
    t.hasSessionReturn = true;

    const exists = await t.hasSession("mawjs-view");
    expect(exists).toBe(true);

    await simulateDetachCleanup(t, "mawjs-view", /* kill */ false);

    const newSessionCalls = t.runCalls.filter(c => c.subcommand === "new-session");
    expect(newSessionCalls).toEqual([]);
    expect(t.killSessionCalls).toEqual([]);
  });

  test("two back-to-back maw-a cycles reuse the same view (no create on second)", async () => {
    const t = new CapturingTmux();

    // Cycle 1 — view doesn't exist yet → create.
    t.hasSessionReturn = false;
    if (!(await t.hasSession("mawjs-view"))) {
      await t.newGroupedSession("101-mawjs", "mawjs-view", { windowSize: "largest" });
    }
    await simulateDetachCleanup(t, "mawjs-view", /* kill */ false);

    // Between cycles: view is still alive (we didn't kill it) → toggle to true.
    t.hasSessionReturn = true;

    // Cycle 2 — view exists → reuse branch, no new-session.
    const runCountBeforeCycle2 = t.runCalls.length;
    if (!(await t.hasSession("mawjs-view"))) {
      await t.newGroupedSession("101-mawjs", "mawjs-view", { windowSize: "largest" });
    }
    await simulateDetachCleanup(t, "mawjs-view", /* kill */ false);

    expect(t.runCalls.length).toBe(runCountBeforeCycle2);
    expect(t.killSessionCalls).toEqual([]);
  });

  test("explicit --kill opt-in → killSession IS called (escape hatch preserved)", async () => {
    const t = new CapturingTmux();
    await simulateDetachCleanup(t, "mawjs-view", /* kill */ true);
    expect(t.killSessionCalls).toEqual(["mawjs-view"]);
  });
});

describe("#420 — impl.ts source-level guard (prevents regression)", () => {
  // The simulate helper above captures the contract. This test also pins the
  // real impl against re-introducing the weCreated auto-kill gate — the
  // specific pattern that caused #420 — without needing a DI refactor of
  // cmdView.
  test("impl.ts has no unconditional/weCreated-gated killSession on detach path", async () => {
    const src = await Bun.file(
      new URL("../src/commands/plugins/view/impl.ts", import.meta.url).pathname,
    ).text();
    expect(src).not.toMatch(/if\s*\(\s*weCreated\s*\)\s*{[^}]*killSession/);
    expect(src).toMatch(/if\s*\(\s*kill\s*\)/);
  });
});
