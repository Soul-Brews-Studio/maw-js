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
 *
 * kobo-490 (this round): the per-site scan used to key on a NAMING
 * CONVENTION (`real[A-Z]`/`_r[A-Z]`), not on what the identifier actually
 * WAS — eq3 proved it: copy a file, rename `realSdk` -> `origSdk`, delete
 * its `suiteStarted` guard entirely, and the old scan still passed (SHA
 * affec00e). `discoverRealHandleIdentifiers()` replaces the name guess with
 * structural discovery: every file starts with one or more root bind-sites
 * (`const X = await import("...")` — X can be named ANYTHING), and every
 * file then builds zero or more DERIVED handles from those roots (an
 * object-literal or spread whose body references a root by property access,
 * e.g. `const anything = { hostExec: X.hostExec }` or `const anything = {
 * ...X }`) — traced to a fixed point, so a 2nd-level derivation built out of
 * a 1st-level derivation is still caught. Renaming any of these — root or
 * derived — changes nothing: the identifier is found by what it's BUILT
 * FROM, never by what it's CALLED. The per-site guard check below (2-line
 * suiteStarted window, same as before) now runs against this DISCOVERED set
 * instead of a hardcoded regex.
 *
 * ⚠️ THIS DESIGN HAS ALREADY BEEN WRONG ONCE, WITHIN THIS SAME ROUND — do not
 * read "structural, not name-based" as "therefore complete". The first
 * version of discoverRealHandleIdentifiers() only matched `.property`
 * access in a derived declaration's body; wake-cmd-branch-coverage.test.ts's
 * `const realWakeMaybeSplit = { ..._rWakeMaybeSplit };` (a pure spread, no
 * `.property` anywhere on that line) was silently undiscovered, meaning its
 * fallthrough sites were never checked at all — found only by recounting
 * discovered handles against every file's real call sites by hand (AC2 of
 * the card), not by the design obviously generalizing. The lesson: this
 * whole card exists because 3 PRIOR tightening rounds each independently
 * believed their check was complete. Treat "known limits" below as "known
 * so far", not "known and closed".
 *
 * KNOWN LIMIT of this guard, still open after kobo-490: discovery is still
 * TEXT-based, not a real parser. It resolves two specific structural shapes
 * — root `await import(...)`, and a derived `const Y = <expr>` reaching a
 * tracked identifier via `.property` OR `...spread`, to a fixed point —
 * because those are the shapes all 12 fixed files actually use TODAY.
 * Shapes it does NOT resolve, because no current file needs them (not
 * because they were ruled out as impossible): a derived handle built via
 * destructuring (`const { hostExec } = realSdk`), one re-exported through a
 * THIRD file instead of built inline, a computed/bracket property name
 * (`X[key]`), or any identifier assembled at runtime (`eval`, string
 * concatenation into a variable name). If any of these appear in a future
 * file, this scanner will not see it, and it needs either a new discovery
 * rule here or falls back to being a review-time catch only — same caveat
 * kobo-483's naming-convention scan carried before this round, and the same
 * kind of gap this round found in itself once already.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

// kobo-490: root bind-sites — `const X = await import("...")`, X can be
// named ANYTHING. Sometimes wraps to a 2nd physical line (`const X =\n  await
// import(...)`) — joinHangingAwaitImport() collapses that onto one logical
// line before this runs, so both shapes are found the same way.
const ROOT_BIND_SITE = /^\s*const\s+(\w+)\s*=\s*await\s+import\(/;

function joinHangingAwaitImport(source: string): string {
  return source.replace(/=\s*\n\s*await\s+import\(/g, "= await import(");
}

// balances { ( [ vs } ) ] across a line — used to find where a multi-line
// const declaration's value actually ends, so its whole body (not just the
// first line) can be checked for references to a known real handle.
function balanceDelta(line: string): number {
  let d = 0;
  for (const ch of line) {
    if (ch === "{" || ch === "(" || ch === "[") d++;
    else if (ch === "}" || ch === ")" || ch === "]") d--;
  }
  return d;
}

// kobo-490: replaces name-matching (`real[A-Z]`/`_r[A-Z]`) with structural
// discovery, because eq3 proved the name-matching version passes clean after
// `realSdk` -> `origSdk` + deleted guard (SHA affec00e). A "real handle" is:
// (a) any root bind-site identifier (PASS 1), or (b) any identifier declared
// as `const Y = <expr>` whose value references an already-known real handle
// via `.property` (an object literal picking specific properties, or a
// spread) — traced to a FIXED POINT so a handle built from another derived
// handle (not just from a root) is still caught, e.g.
// cmd-update-runtime-coverage.test.ts's derived handles are all 1 level from
// their roots, but the fixed-point loop means a 2nd level would be caught
// too if one existed. Renaming never removes an identifier from this set —
// discovery never looks at the name, only at what built it.
function discoverRealHandleIdentifiers(source: string): Set<string> {
  const lines = joinHangingAwaitImport(source).split("\n");
  const tracked = new Set<string>();

  for (const line of lines) {
    const m = line.match(ROOT_BIND_SITE);
    if (m) tracked.add(m[1]);
  }

  const DERIVED_DECL = /^\s*const\s+(\w+)\s*=\s*(?!await\s+import\()\S/;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(DERIVED_DECL);
      if (!m || tracked.has(m[1])) continue;
      let body = lines[i];
      let depth = balanceDelta(lines[i]);
      let j = i;
      while (depth > 0 && j < lines.length - 1 && j - i < 80) {
        j++;
        body += "\n" + lines[j];
        depth += balanceDelta(lines[j]);
      }
      for (const id of tracked) {
        // kobo-490 fix during self-verification (AC2): a PURE spread
        // (`const realConfig = { ..._rConfig };`, no `.property` access
        // anywhere in the body) was silently missed — `\bid\.` only matches
        // property access, never `...id`. Found by recounting discovered
        // handles myself against wake-cmd-branch-coverage.test.ts's actual
        // source rather than trusting the design would obviously cover it.
        if (new RegExp("\\b" + id + "\\.").test(body) || new RegExp("\\.\\.\\.\\s*" + id + "\\b").test(body)) {
          tracked.add(m[1]);
          changed = true;
          break;
        }
      }
    }
  }

  return tracked;
}

// Reviewer found the original check ("at least 1 realCallForbidden( call
// site beyond its own definition") too weak: mutating 27 of 30 fixed sites
// back to the old bare fallthrough — leaving only 3 — still passed, because
// the check only counted markers, never verified WHICH sites had them. This
// walks every line that returns/ternary-falls-through to a DISCOVERED real
// handle (kobo-490: was a `real*`/`_r*` name guess, now the traced set above)
// and requires `suiteStarted` to appear on that line or either of the 2
// lines above it — the actual shape of every fix in this PR. A site with the
// old single-guard pattern (`if (!mockActive) return real...`, no nested
// suiteStarted check) fails this even if realCallForbidden still exists
// elsewhere in the file.
function findUnguardedRealFallthroughs(source: string): string[] {
  const handles = discoverRealHandleIdentifiers(source);
  const lines = source.split("\n");
  const unguarded: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let isFallthrough = false;
    for (const id of handles) {
      if (new RegExp("(?:return\\s*\\(?|:\\s*)\\b" + id + "\\.\\w+\\(").test(lines[i])) {
        isFallthrough = true;
        break;
      }
    }
    if (!isFallthrough) continue;
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
// site safe. As of this test, it appears exactly 5 times across the 12
// fixed files, each independently justified in-code (unrelated config-key
// reads, one opt-in test technique) — no buffer added on top of that real
// count on purpose: a buffer just delays the moment someone notices growth,
// it doesn't prevent it. This is not a scanner for NEW misuse (a marker
// added correctly and one added to dodge this test look identical in text) —
// it is a tripwire against silent growth: whoever adds the Nth occurrence is
// reading this file, the same way whoever fixes the 13th real-fallthrough
// file reads kobo-483's own reasoning. If this budget needs raising, raise
// it deliberately in the same PR that adds the justified use, not by editing
// past it quietly.
const INTENTIONAL_REAL_READ_BUDGET = 5;

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

        test("every discovered real-handle fallthrough site is suiteStarted-guarded (not just present somewhere) — kobo-490: discovered structurally, not by name", () => {
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

// kobo-490 AC1: reproduce eq3's exact evasion (SHA affec00e) as a permanent
// regression test — not a one-off manual check. This mutates an in-memory
// COPY of a real fixed file's source (never touches the file on disk, never
// imports/executes it) the same way eq3 did: rename the derived real-handle
// identifier to something that shares NO prefix with `real`/`_r`, then
// delete one of its guards entirely. Before kobo-490, findUnguardedRealFallthroughs
// keyed on the name and missed this; it must not miss it now.
describe("kobo-490 — the guard resists a renamed handle, not just a `real`/`_r`-named one", () => {
  const originalSource = readFileSync(join(REPO_ROOT, "test/wake-cmd-cmdwake-coverage.test.ts"), "utf-8");

  test("sanity: the real file, unmutated, has zero unguarded fallthroughs (baseline before mutating)", () => {
    expect(findUnguardedRealFallthroughs(originalSource)).toEqual([]);
  });

  test("eq3's evasion, reproduced: rename realSdk -> origSdk (no real/_r prefix) + delete hostExec's guard -> still caught", () => {
    let mutated = originalSource.replace(/\brealSdk\b/g, "origSdk");
    const guarded = 'if (!suiteStarted) return origSdk.hostExec(cmd);\n      return realCallForbidden("hostExec");';
    const unguarded = "return origSdk.hostExec(cmd);";
    expect(mutated).toContain(guarded); // the guard exists pre-mutation, under its new name
    mutated = mutated.replace(guarded, unguarded);

    const oldNamingScan = /(?:return\s*\(?|:\s*)\b(?:real[A-Z]\w*|_r[A-Z]\w*)\b\.\w+\(/.test(
      "return origSdk.hostExec(cmd);",
    );
    expect(oldNamingScan).toBe(false); // confirms this IS the blind spot — "origSdk" matches neither real[A-Z] nor _r[A-Z]

    const found = findUnguardedRealFallthroughs(mutated);
    expect(found.some((line) => line.includes("origSdk.hostExec(cmd)"))).toBe(true);
  });

  test("renaming alone, guard left intact, is NOT flagged — this guard watches for missing suiteStarted, not for renaming itself", () => {
    const renamedOnly = originalSource.replace(/\brealSdk\b/g, "origSdk");
    expect(findUnguardedRealFallthroughs(renamedOnly)).toEqual([]);
  });

  // kobo-490 self-caught gap (AC2 recount, not eq3's demo): a PURE spread
  // derivation (`const realWakeMaybeSplit = { ..._rWakeMaybeSplit };` — no
  // `.property` access anywhere in that one-line body) was silently
  // undiscovered on the first pass, because the fixed-point body-reference
  // check only looked for `id.`, never `...id`. Found by recounting
  // discovered handles myself against every file's actual call sites (AC2),
  // not by trusting the design would obviously generalize. This locks the
  // fix in.
  const branchSource = readFileSync(join(REPO_ROOT, "test/isolated/wake-cmd-branch-coverage.test.ts"), "utf-8");

  test("a spread-derived handle (`{ ..._rX }`, no `.property` anywhere in its own declaration) is still discovered and its unguarded fallthrough still caught", () => {
    expect(branchSource).toContain("const realWakeMaybeSplit = { ..._rWakeMaybeSplit };"); // confirms this file still uses pure-spread derivation
    const guarded = "if (!suiteStarted) return realWakeMaybeSplit.maybeSplit(target, opts);";
    const unguarded = "return realWakeMaybeSplit.maybeSplit(target, opts);";
    expect(branchSource).toContain(guarded);
    const mutated = branchSource.replace(guarded, unguarded);

    const found = findUnguardedRealFallthroughs(mutated);
    expect(found.some((line) => line.includes("realWakeMaybeSplit.maybeSplit(target, opts)"))).toBe(true);
  });
});
