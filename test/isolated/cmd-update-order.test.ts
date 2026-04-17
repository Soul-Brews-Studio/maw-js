/**
 * Regression guard — source-order invariant for maw update command.
 *
 * Backstory: the original cmd-update ran `bun remove -g maw` BEFORE ref
 * validation. A rejected ref or a subsequent install failure would leave
 * the user with no maw binary. Fixed in #476 (emergency alpha.130) + the
 * atomic flow that followed.
 *
 * This test reads the source file and asserts two invariants:
 *   1. The REF_RE allowlist check appears BEFORE any `bun remove` call
 *   2. `bun add` appears BEFORE `bun remove` in the atomic happy-path
 *      (the remove-as-fallback is only on failure, and still only after
 *      at least one install attempt)
 *
 * If someone refactors this file without preserving the invariants, this
 * test catches it — not by behavior (hard to test spawn ordering in unit
 * test) but by text structure. Crude but targeted.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const cmdUpdatePath = join(import.meta.dir, "../../src/cli/cmd-update.ts");

describe("cmd-update source-order invariants", () => {
  const src = readFileSync(cmdUpdatePath, "utf-8");

  // Find the actual execSync(`bun remove -g maw`) call — not any comment or
  // docstring that mentions the invariant. Must look for the execSync call
  // specifically with the bun remove template-literal.
  const REMOVE_CALL_RE = /execSync\s*\(\s*`bun remove -g maw`/;
  const ADD_SPAWN_RE = /Bun\.spawn\s*\(\s*\["bun",\s*"add"/;

  it("REF_RE validation precedes the actual `bun remove` execSync call", () => {
    const refReIdx = src.indexOf("REF_RE");
    const removeCallMatch = src.match(REMOVE_CALL_RE);
    expect(refReIdx).toBeGreaterThan(-1);
    expect(removeCallMatch).not.toBeNull();
    const removeCallIdx = removeCallMatch!.index!;
    expect(refReIdx).toBeLessThan(removeCallIdx);
  });

  it("`Bun.spawn(['bun', 'add', ...])` appears before the `bun remove` execSync (atomic: try add first)", () => {
    const addSpawnMatch = src.match(ADD_SPAWN_RE);
    const removeCallMatch = src.match(REMOVE_CALL_RE);
    expect(addSpawnMatch).not.toBeNull();
    expect(removeCallMatch).not.toBeNull();
    expect(addSpawnMatch!.index!).toBeLessThan(removeCallMatch!.index!);
  });

  it("install retry path exists (bun remove is only reached on failure)", () => {
    // The remove step should be inside a fallback branch, not in the
    // primary install path. Look for the fallback warning text.
    expect(src).toContain("first install attempt failed");
    expect(src).toContain("clearing stale global refs");
  });

  it("failure path prints recovery command", () => {
    expect(src).toMatch(/manual recovery: bun add -g github:/);
  });
});
