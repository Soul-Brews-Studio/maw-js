/**
 * kobo-405 — global test preload (wired via bunfig.toml `[test] preload`), so it
 * runs before EVERY `bun test` invocation in this repo, including a bare
 * `bun test <file>` that bypasses every package script and its
 * `MAW_TEST_MODE=1`. Task-event delivery (notify.ts's spawnHey + task/index.ts's
 * ping()) used to be guarded ONLY by that env var — a human had to remember to
 * set it, or a test whose fixture named a real oracle fired a genuine `maw hey`
 * into a live tmux pane (the mechanism behind a night of stray cross-pane
 * pings, kobo-399/405).
 *
 * This replaces the ONE shared spawn point (core/tasks/hey-spawn.ts) with a
 * stub that throws instead of shelling out — fail-closed, and NOT env-dependent:
 * it fires regardless of MAW_TEST_MODE. The throw is swallowed by the existing
 * best-effort try/catch around every call site (delivery failure was already a
 * non-fatal no-op by design), so this changes "silently spawns a real process"
 * into "silently no-ops" — never a behavior change for a passing test, always a
 * behavior change for what would have been a live-pane leak.
 *
 * A test that genuinely needs to assert the real spawn wiring (see
 * hey-spawn.test.ts) re-mocks `Bun.spawn` itself, LOCALLY, in its own file —
 * that's an explicit, visible opt-in, not a silent default.
 */
import { mock } from "bun:test";
import { join } from "path";

const HEY_SPAWN_MODULE = join(import.meta.dir, "../../src/core/tasks/hey-spawn");

mock.module(HEY_SPAWN_MODULE, () => ({
  spawnHeyProcess(): void {
    throw new Error(
      "kobo-405: a test attempted a REAL `maw hey` spawn via core/tasks/hey-spawn. " +
        "notifyTaskComment/notifyReviewer/notifyCommentReply/notifyParentOfSubcardDone all " +
        "accept an injectable `send` callback — pass one instead of relying on the module " +
        "default when asserting delivery behavior.",
    );
  },
}));
