/**
 * kobo-508 M2 — %11's prediction: reverting server.ts:339's paneIdle callback
 * back to a bare `checkPaneIdle` (dropping the isSafeToInject combination)
 * left NOTHING red. The existing dispatch-engine guard tests stub `paneIdle`
 * itself, which proves the SWEEP logic behaves correctly given some callback —
 * it never proves server.ts installs the RIGHT callback. This file imports
 * `sweepPaneIdleCheck` directly (the real exported wiring, not a re-created
 * stub) and only mocks the underlying tmux capture, so the real
 * checkPaneIdle + detectPermissionMenu logic runs for real.
 *
 * kobo-394 lesson applied to the test itself: this only proves what THIS
 * function does. It does not enumerate every send path in the codebase.
 */
import { describe, test, expect, mock } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");

let captureResponse = "";

const realSdk = await import("../../src/sdk");
mock.module(join(srcRoot, "src/sdk"), () => ({
  ...realSdk,
  capture: async () => captureResponse,
}));

const { sweepPaneIdleCheck } = await import("../../src/core/server");

describe("kobo-508 M2 — server.ts's real paneIdle wiring, not a stubbed callback", () => {
  test("a menu row drawn in reverse (would fool checkPaneIdle alone) is still NOT safe to inject", async () => {
    captureResponse = [
      " Do you want to proceed?",
      " \x1b[7m❯ 1. Yes\x1b[27m",
      "   2. Yes, and don't ask again for: maw inbox *",
      "   3. No",
      "",
      " Esc to cancel · Tab to amend · ctrl+e to explain",
    ].join("\n");

    expect(await sweepPaneIdleCheck("pane:0.0")).toBe(false);
  });

  test("real operator typing is NOT safe to inject", async () => {
    captureResponse = "❯ hello world\n";
    expect(await sweepPaneIdleCheck("pane:0.0")).toBe(false);
  });

  test("a truly empty prompt IS safe to inject", async () => {
    captureResponse = "❯ \n";
    expect(await sweepPaneIdleCheck("pane:0.0")).toBe(true);
  });
});
