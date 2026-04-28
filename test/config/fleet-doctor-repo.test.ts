/**
 * Tests for src/commands/shared/fleet-doctor-checks-repo.ts — checkMissingRepos.
 * Uses real temp directory.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { checkMissingRepos, type FleetEntryLike } from "../../src/commands/shared/fleet-doctor-checks-repo";

const TMP = join(tmpdir(), `maw-ghq-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(join(TMP, "org", "existing-repo"), { recursive: true });
  mkdirSync(join(TMP, "github.com", "org", "nested-repo"), { recursive: true });
});
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

function entry(name: string, repo?: string): FleetEntryLike {
  return { session: { name, windows: [{ repo }] } };
}

describe("checkMissingRepos", () => {
  it("returns empty for existing direct repo", () => {
    const findings = checkMissingRepos([entry("01-test", "org/existing-repo")], TMP);
    expect(findings).toHaveLength(0);
  });

  it("returns empty for existing nested repo (github.com/)", () => {
    const findings = checkMissingRepos([entry("01-test", "org/nested-repo")], TMP);
    expect(findings).toHaveLength(0);
  });

  it("returns finding for missing repo", () => {
    const findings = checkMissingRepos([entry("01-gone", "org/missing-repo")], TMP);
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe("missing-repo");
    expect(findings[0].level).toBe("info");
    expect(findings[0].message).toContain("missing-repo");
  });

  it("skips entries without repo", () => {
    const findings = checkMissingRepos([entry("01-norepo")], TMP);
    expect(findings).toHaveLength(0);
  });

  it("returns finding per missing entry", () => {
    const entries = [
      entry("01-a", "org/missing-a"),
      entry("02-b", "org/missing-b"),
      entry("03-c", "org/existing-repo"),
    ];
    const findings = checkMissingRepos(entries, TMP);
    expect(findings).toHaveLength(2);
  });

  it("finding includes session name and repo in detail", () => {
    const findings = checkMissingRepos([entry("05-neo", "soul/neo-oracle")], TMP);
    expect(findings[0].detail.session).toBe("05-neo");
    expect(findings[0].detail.repo).toBe("soul/neo-oracle");
  });

  it("finding is not fixable", () => {
    const findings = checkMissingRepos([entry("x", "org/nope")], TMP);
    expect(findings[0].fixable).toBe(false);
  });
});
