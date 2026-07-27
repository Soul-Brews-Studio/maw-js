/**
 * kobo-483-fail-closed-conformance.test.ts — guards the guard.
 *
 * kobo-477 found several test files silently fall through to REAL tmux/exec
 * implementations when a `mockActive` toggle misfires mid-suite. kobo-483
 * fixed each one: a `suiteStarted` flag + a `realCallForbidden()`/
 * `resolveMock()` pair now throw instead of touching anything real once the
 * suite has started.
 *
 * One of the 12 (test/tmux-sendtext-submit.test.ts) has a different shape —
 * no toggle, no mock.module(), a subclass that overrides individual
 * primitives — so its fail-closed fix is different too: it overrides the
 * shared `run()` bottleneck instead, since every Tmux method funnels through
 * it before reaching hostExec. Same guarantee, different shape; checked with
 * its own assertions below (`kind: "bottleneck-override"`), not forced into
 * the toggle-file checks.
 *
 * These fixes live inside files that themselves can't be safely exercised
 * here (running them is exactly the touch-real-tmux risk this whole
 * investigation is about, and the machine-wide test STOP is still in effect
 * while that's being resolved). So this file does NOT import or run any of
 * them — it reads each one as plain text and asserts the fail-closed markers
 * are present. Pure file reads + string checks: no tmux, no exec, no
 * network, nothing this needs the STOP to worry about.
 *
 * NOT under test: the exact wording of any thrown error, or line numbers —
 * kobo-426's `room.test.ts:98` scar (locking a literal string, going red on
 * a capability-preserving change) applies here too.
 *
 * 3rd tightening round (reviewer): a per-site scan still can't see a revert
 * INSIDE the shared resolveMock() helper itself — collapsing its body from
 * "real only during module-load, else throw" down to "always real" un-fails-
 * closes every call site in a file at once, in 2 lines, and stays invisible
 * to a per-line scan (the helper's own params are named `real`/`fake`,
 * lowercase — REAL_FALLTHROUGH_LINE doesn't match them). resolveMockBodyIsIntact()
 * checks the helper's own definition, not just its call sites.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

// Reviewer found the original check ("at least 1 realCallForbidden( call
// site beyond its own definition") too weak: mutating 27 of 30 fixed sites
// back to the old bare fallthrough — leaving only 3 — still passed, because
// the check only counted markers, never verified WHICH sites had them. This
// walks every line that returns/ternary-falls-through to a `real*`/`_r*`
// reference and requires `suiteStarted` to appear on that line or either of
// the 2 lines above it — the actual shape of every fix in this PR. A site
// with the old single-guard pattern (`if (!mockActive) return real...`, no
// nested suiteStarted check) fails this even if realCallForbidden still
// exists elsewhere in the file.
const REAL_FALLTHROUGH_LINE = /(?:return\s*\(?|:\s*)\b(?:real[A-Z]\w*|_r[A-Z]\w*)\b\.\w+\(/;

function findUnguardedRealFallthroughs(source: string): string[] {
  const lines = source.split("\n");
  const unguarded: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!REAL_FALLTHROUGH_LINE.test(lines[i])) continue;
    const windowStart = Math.max(0, i - 2);
    const nearby = lines.slice(windowStart, i + 1).join("\n");
    // kobo-483-intentional-real-read: a small number of sites deliberately
    // always fall through to a real reader for an unrelated config key —
    // not the mockActive race this scan is otherwise checking for. Marked
    // explicitly in the source, right next to the line, not silently exempt.
    if (nearby.includes("kobo-483-intentional-real-read")) continue;
    if (!nearby.includes("suiteStarted")) {
      unguarded.push(`line ${i + 1}: ${lines[i].trim()}`);
    }
  }
  return unguarded;
}

// Reviewer's 2nd finding: a per-site check still can't see a revert INSIDE
// the shared resolveMock() helper itself — changing its body from
// `if (!suiteStarted) return real(); return realCallForbidden(label);` down
// to just `return real();` un-fails-closes every call site in the file at
// once, in 2 lines, and the per-site scan above never notices (the helper's
// own parameters are named `real`/`fake`, lowercase, so REAL_FALLTHROUGH_LINE
// doesn't even match them). If a file defines resolveMock, that definition's
// body must itself still call realCallForbidden.
function resolveMockBodyIsIntact(source: string): boolean {
  const defIndex = source.indexOf("function resolveMock");
  if (defIndex === -1) return true; // file doesn't define it — nothing to check here
  const braceStart = source.indexOf("{", defIndex);
  if (braceStart === -1) return false;
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = source.slice(braceStart, i + 1);
  return body.includes("realCallForbidden");
}

// The 12 files kobo-483 made fail-closed. If a future PR adds another file
// with a real-fallthrough shape (toggle-based or otherwise), it belongs on
// this list too — that's a deliberate, visible list to edit, not something
// this test discovers on its own (this file proves fixed files STAY fixed;
// kobo-477's own repo-wide re-sweep is what finds new ones). Most use the
// suiteStarted/resolveMock toggle pattern; one (tmux-sendtext-submit) has no
// toggle at all — a subclass that's safe by overriding the shared `run()`
// bottleneck instead — so it's checked with a different shape below.
const FIXED_FILES: Array<{ path: string; kind: "toggle" | "bottleneck-override" }> = [
  { path: "test/wake-cmd-cmdwake-coverage.test.ts", kind: "toggle" },
  { path: "test/wake-target-ensure-cloned.test.ts", kind: "toggle" },
  { path: "test/wake-resolve-impl-runtime-coverage.test.ts", kind: "toggle" },
  { path: "test/isolated/pty-transport-coverage.test.ts", kind: "toggle" },
  { path: "test/isolated/wake-cmd-branch-coverage.test.ts", kind: "toggle" },
  { path: "test/comm-send-durable-inbox.test.ts", kind: "toggle" },
  { path: "test/comm-send-cmdsend-coverage.test.ts", kind: "toggle" },
  { path: "test/artifacts-command-default.test.ts", kind: "toggle" },
  { path: "test/peers-transport-coverage.test.ts", kind: "toggle" },
  { path: "test/cmd-update-runtime-coverage.test.ts", kind: "toggle" },
  { path: "test/wake-maybe-split-coverage.test.ts", kind: "toggle" },
  { path: "test/tmux-sendtext-submit.test.ts", kind: "bottleneck-override" },
];

// `kobo-483-intentional-real-read` is a lock anyone can also use as a key —
// it's a plain string in the source, easier to add than to actually make a
// site safe. As of this test, it appears 6 times across the 12 fixed files,
// each independently justified in-code (unrelated config-key reads, one
// opt-in test technique). This is not a scanner for NEW misuse (a marker
// added correctly and one added to dodge this test look identical in text) —
// it is a tripwire against silent growth: whoever adds the Nth occurrence is
// reading this file, the same way whoever fixes the 13th real-fallthrough
// file reads kobo-483's own reasoning. If this budget needs raising, raise
// it deliberately in the same PR that adds the justified use, not by editing
// past it quietly.
const INTENTIONAL_REAL_READ_BUDGET = 8;

describe("kobo-483 — fail-closed mock harness stays fail-closed", () => {
  test(`kobo-483-intentional-real-read stays within its budget (${INTENTIONAL_REAL_READ_BUDGET}) across all fixed files`, () => {
    const total = FIXED_FILES.reduce((sum, { path: relPath }) => {
      const source = readFileSync(join(REPO_ROOT, relPath), "utf-8");
      const matches = source.match(/kobo-483-intentional-real-read/g) ?? [];
      return sum + matches.length;
    }, 0);
    expect(total).toBeLessThanOrEqual(INTENTIONAL_REAL_READ_BUDGET);
  });

  for (const { path: relPath, kind } of FIXED_FILES) {
    describe(relPath, () => {
      const source = readFileSync(join(REPO_ROOT, relPath), "utf-8");

      if (kind === "toggle") {
        test("has a suiteStarted latch (module-load window vs mid-suite)", () => {
          expect(source).toMatch(/\blet suiteStarted = false\b/);
        });

        test("every real*/_r* fallthrough site is suiteStarted-guarded (not just present somewhere)", () => {
          const unguarded = findUnguardedRealFallthroughs(source);
          expect(unguarded).toEqual([]);
        });

        test("if this file defines resolveMock(), its body still calls realCallForbidden (not just its call sites)", () => {
          expect(resolveMockBodyIsIntact(source)).toBe(true);
        });
      } else {
        test("overrides the run() bottleneck, not just the individual primitives", () => {
          expect(source).toMatch(/\basync run\(subcommand:/);
        });

        test("carries the fail-closed marker (throws instead of falling through)", () => {
          expect(source).toContain("[kobo-483 fail-closed]");
        });
      }
    });
  }
});
