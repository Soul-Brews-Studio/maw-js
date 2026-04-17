import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolvePsi } from "../../src/commands/plugins/team/team-helpers";

// Regression test for #393 Bug A — resolvePsi walks up from cwd to find
// oracle root (CLAUDE.md + ψ/), preventing rogue nested vaults when the
// CLI is run from a sub-directory.

let oracleRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  oracleRoot = mkdtempSync(join(tmpdir(), "maw-resolvepsi-test-"));
  mkdirSync(join(oracleRoot, "ψ", "memory", "mailbox"), { recursive: true });
  writeFileSync(join(oracleRoot, "CLAUDE.md"), "# test oracle\n");
});

afterEach(() => {
  process.chdir(originalCwd);
  try { rmSync(oracleRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

describe("resolvePsi — walks up from cwd (#393 Bug A)", () => {
  test("returns <root>/ψ when cwd is the oracle root", () => {
    process.chdir(oracleRoot);
    expect(resolvePsi()).toBe(join(oracleRoot, "ψ"));
  });

  test("walks up one level — cwd is a sub-directory", () => {
    const sub = join(oracleRoot, "ψ", "writing");
    mkdirSync(sub, { recursive: true });
    process.chdir(sub);
    expect(resolvePsi()).toBe(join(oracleRoot, "ψ"));
  });

  test("walks up multiple levels — deeply nested cwd", () => {
    const deep = join(oracleRoot, "ψ", "writing", "2026-04-17", "clarity");
    mkdirSync(deep, { recursive: true });
    process.chdir(deep);
    expect(resolvePsi()).toBe(join(oracleRoot, "ψ"));
  });

  test("does NOT descend past a non-oracle sub-dir (no rogue nested vault)", () => {
    // Create a ψ/ child of the oracle root that doesn't have its own CLAUDE.md
    const nestedPsi = join(oracleRoot, "ψ", "writing", "ψ");
    mkdirSync(nestedPsi, { recursive: true });
    const below = join(oracleRoot, "ψ", "writing");
    process.chdir(below);
    // Should return the OUTER ψ (root), not the rogue inner one
    expect(resolvePsi()).toBe(join(oracleRoot, "ψ"));
  });

  test("fallback — no oracle root up the tree returns cwd/ψ", () => {
    const orphan = mkdtempSync(join(tmpdir(), "maw-orphan-"));
    try {
      process.chdir(orphan);
      expect(resolvePsi()).toBe(join(orphan, "ψ"));
    } finally {
      try { rmSync(orphan, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  test("requires BOTH markers: ψ/ alone without CLAUDE.md falls through", () => {
    const fakeOracle = mkdtempSync(join(tmpdir(), "maw-fake-"));
    mkdirSync(join(fakeOracle, "ψ"), { recursive: true });
    // no CLAUDE.md written
    const sub = join(fakeOracle, "ψ", "writing");
    mkdirSync(sub, { recursive: true });
    try {
      process.chdir(sub);
      // Walks up, but fakeOracle is missing CLAUDE.md → falls through
      // Should NOT match fakeOracle. Falls back to cwd/ψ.
      expect(resolvePsi()).toBe(join(sub, "ψ"));
    } finally {
      try { rmSync(fakeOracle, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });
});
