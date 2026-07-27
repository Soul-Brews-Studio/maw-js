/**
 * kobo-483-fail-closed-conformance.test.ts — guards the guard.
 *
 * kobo-477 found several test files silently fall through to REAL tmux/exec
 * implementations when a `mockActive` toggle misfires mid-suite. kobo-483
 * fixed each one: a `suiteStarted` flag + a `realCallForbidden()`/
 * `resolveMock()` pair now throw instead of touching anything real once the
 * suite has started.
 *
 * That fix lives inside 10 test files that themselves can't be safely
 * exercised here (running them is exactly the touch-real-tmux risk this
 * whole investigation is about, and the machine-wide test STOP is still in
 * effect while that's being resolved). So this file does NOT import or run
 * any of them — it reads each one as plain text and asserts the fail-closed
 * markers are present. Pure file reads + string checks: no tmux, no exec, no
 * network, nothing this needs the STOP to worry about.
 *
 * Capability under test: each fixed file still has (a) a `suiteStarted`
 * latch and (b) at least one live `realCallForbidden(` call site. NOT under
 * test: the exact wording of the thrown error, or line numbers — kobo-426's
 * `room.test.ts:98` scar (locking a literal string, going red on a
 * capability-preserving change) applies here too.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

// The 10 files kobo-483 made fail-closed. If a future PR adds another file
// with the same mockActive-real-fallthrough shape, it belongs on this list
// too — that's a deliberate, visible list to edit, not something this test
// discovers on its own (this file proves fixed files STAY fixed; kobo-477's
// own repo-wide re-sweep is what finds new ones).
const FIXED_FILES = [
  "test/wake-cmd-cmdwake-coverage.test.ts",
  "test/wake-target-ensure-cloned.test.ts",
  "test/wake-resolve-impl-runtime-coverage.test.ts",
  "test/isolated/pty-transport-coverage.test.ts",
  "test/isolated/wake-cmd-branch-coverage.test.ts",
  "test/comm-send-durable-inbox.test.ts",
  "test/comm-send-cmdsend-coverage.test.ts",
  "test/artifacts-command-default.test.ts",
  "test/peers-transport-coverage.test.ts",
  "test/cmd-update-runtime-coverage.test.ts",
  "test/wake-maybe-split-coverage.test.ts",
];

describe("kobo-483 — fail-closed mock harness stays fail-closed", () => {
  for (const relPath of FIXED_FILES) {
    describe(relPath, () => {
      const source = readFileSync(join(REPO_ROOT, relPath), "utf-8");

      test("has a suiteStarted latch (module-load window vs mid-suite)", () => {
        expect(source).toMatch(/\blet suiteStarted = false\b/);
      });

      test("has at least one live realCallForbidden(...) throw site", () => {
        const forbiddenCallCount = (source.match(/realCallForbidden\(/g) ?? []).length;
        // 1 is the function's own declaration/definition line; a file with
        // no call sites beyond that would mean nothing actually throws.
        expect(forbiddenCallCount).toBeGreaterThan(1);
      });
    });
  }
});
