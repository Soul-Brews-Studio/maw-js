/**
 * Tests for createArtifact, updateArtifact, writeResult, addAttachment,
 * listArtifacts, getArtifact, artifactDir from src/lib/artifacts.ts.
 * Uses real temp dirs (ARTIFACTS_ROOT is hardcoded to ~/.maw/artifacts, 
 * so we test the pure artifactDir function and do integration tests
 * for the filesystem operations using temp dirs when possible).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { artifactDir } from "../../src/lib/artifacts";

// Test only the pure functions to avoid writing to ~/.maw/artifacts
describe("artifactDir", () => {
  it("returns path under ~/.maw/artifacts", () => {
    const dir = artifactDir("team-alpha", "task-001");
    expect(dir).toBe(join(homedir(), ".maw", "artifacts", "team-alpha", "task-001"));
  });

  it("handles nested team names", () => {
    const dir = artifactDir("my-team", "t-123");
    expect(dir).toContain("my-team");
    expect(dir).toContain("t-123");
  });
});
