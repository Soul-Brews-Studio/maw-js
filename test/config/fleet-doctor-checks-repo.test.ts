/**
 * Tests for checkMissingRepos from src/commands/shared/fleet-doctor-checks-repo.ts.
 * Uses real temp dirs to test filesystem existence checks.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { checkMissingRepos } from "../../src/commands/shared/fleet-doctor-checks-repo";
import type { FleetEntryLike } from "../../src/commands/shared/fleet-doctor-checks-repo";

let ghqRoot: string;

beforeEach(() => {
  ghqRoot = mkdtempSync(join(tmpdir(), "fleet-check-repo-"));
});

function makeEntry(name: string, repo?: string): FleetEntryLike {
  return {
    session: {
      name,
      windows: repo ? [{ repo }] : [{}],
    },
  };
}

describe("checkMissingRepos", () => {
  it("returns empty for no entries", () => {
    const result = checkMissingRepos([], ghqRoot);
    expect(result).toEqual([]);
  });

  it("skips entries with no repo", () => {
    const result = checkMissingRepos([makeEntry("session1")], ghqRoot);
    expect(result).toEqual([]);
  });

  it("reports missing repo", () => {
    const result = checkMissingRepos(
      [makeEntry("session1", "org/missing-repo")],
      ghqRoot,
    );
    expect(result).toHaveLength(1);
    expect(result[0].check).toBe("missing-repo");
    expect(result[0].level).toBe("info");
    expect(result[0].fixable).toBe(false);
    expect(result[0].message).toContain("missing-repo");
  });

  it("passes when repo exists at direct path", () => {
    mkdirSync(join(ghqRoot, "org", "my-repo"), { recursive: true });
    const result = checkMissingRepos(
      [makeEntry("session1", "org/my-repo")],
      ghqRoot,
    );
    expect(result).toHaveLength(0);
  });

  it("passes when repo exists at github.com nested path", () => {
    mkdirSync(join(ghqRoot, "github.com", "org", "my-repo"), { recursive: true });
    const result = checkMissingRepos(
      [makeEntry("session1", "org/my-repo")],
      ghqRoot,
    );
    expect(result).toHaveLength(0);
  });

  it("reports multiple missing repos", () => {
    const result = checkMissingRepos(
      [
        makeEntry("s1", "org/repo-a"),
        makeEntry("s2", "org/repo-b"),
      ],
      ghqRoot,
    );
    expect(result).toHaveLength(2);
  });

  it("mixes found and missing repos", () => {
    mkdirSync(join(ghqRoot, "org", "found-repo"), { recursive: true });
    const result = checkMissingRepos(
      [
        makeEntry("s1", "org/found-repo"),
        makeEntry("s2", "org/gone-repo"),
      ],
      ghqRoot,
    );
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain("gone-repo");
  });

  it("includes paths in detail", () => {
    const result = checkMissingRepos(
      [makeEntry("s1", "org/repo")],
      ghqRoot,
    );
    expect(result[0].detail.paths).toHaveLength(2);
    expect(result[0].detail.paths[0]).toContain("org/repo");
  });
});
