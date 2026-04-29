/**
 * test/isolated/session-whoami-inline.test.ts
 *
 * Regression test for #953: `maw session` errored with
 *   ResolveMessage: Cannot find module '../whoami/index'
 * because session/index.ts re-exported the deleted whoami/ plugin
 * (extracted to registry in #936).
 *
 * After the fix, session/index.ts inlines the ~5-line whoami impl.
 * This test pins:
 *   1. The module imports without throwing (catches future dangling imports).
 *   2. The handler returns ok with non-empty output when TMUX is set.
 *   3. The handler returns a UserError-shaped failure when TMUX is unset.
 *
 * Isolated because mock.module on src/core/transport/ssh is process-global.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mockSshModule } from "../helpers/mock-ssh";

// Stub hostExec so the test never shells out to a real tmux.
let lastCmd = "";
const fakeSession = "oracle-session-953";
mock.module("../../src/core/transport/ssh", () =>
  mockSshModule({
    hostExec: async (cmd: string) => {
      lastCmd = cmd;
      // tmux display-message -p '#S' returns the session name with a trailing newline.
      return `${fakeSession}\n`;
    },
  }),
);

describe("session/ inlined whoami (fix #953)", () => {
  let savedTmux: string | undefined;
  let savedTmuxPane: string | undefined;

  beforeEach(() => {
    savedTmux = process.env.TMUX;
    savedTmuxPane = process.env.TMUX_PANE;
    lastCmd = "";
  });

  afterEach(() => {
    if (savedTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = savedTmux;
    if (savedTmuxPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = savedTmuxPane;
  });

  test("module imports without throwing (no dangling whoami import)", async () => {
    const mod = await import("../../src/commands/plugins/session/index");
    expect(mod.command).toBeDefined();
    expect(mod.command.name).toBe("session");
    expect(typeof mod.default).toBe("function");
  });

  test("handler returns non-empty session name when TMUX is set", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,1234,5";
    process.env.TMUX_PANE = "%42";

    const { default: handler } = await import("../../src/commands/plugins/session/index");
    const result = await handler({ source: "api", args: [] });

    expect(result.ok).toBe(true);
    expect(result.output).toBeDefined();
    expect((result.output ?? "").length).toBeGreaterThan(0);
    expect(result.output).toContain(fakeSession);
    // It should have shelled out via tmux display-message — proving we're
    // running the inlined impl, not a stub.
    expect(lastCmd).toContain("tmux display-message");
    expect(lastCmd).toContain("#S");
  });

  test("handler fails cleanly when TMUX is unset (UserError path)", async () => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;

    const { default: handler } = await import("../../src/commands/plugins/session/index");
    const result = await handler({ source: "api", args: [] });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("tmux");
  });
});
