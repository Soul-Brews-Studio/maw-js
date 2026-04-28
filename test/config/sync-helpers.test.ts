/**
 * Tests for syncDir, syncOracleVaults, syncProjectVault from
 * src/commands/plugins/soul-sync/sync-helpers.ts.
 * Uses real temp dirs — no mocking needed.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { syncDir, syncOracleVaults, syncProjectVault } from "../../src/commands/plugins/soul-sync/sync-helpers";

let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `maw-test-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─── syncDir ────────────────────────────────────────────────────────────────

describe("syncDir", () => {
  it("returns 0 for nonexistent source", () => {
    expect(syncDir(join(tmp, "nope"), join(tmp, "dst"))).toBe(0);
  });

  it("copies new files from src to dst", () => {
    const src = join(tmp, "src");
    const dst = join(tmp, "dst");
    mkdirSync(src, { recursive: true });
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(src, "a.md"), "hello");
    const count = syncDir(src, dst);
    expect(count).toBe(1);
    expect(readFileSync(join(dst, "a.md"), "utf8")).toBe("hello");
  });

  it("skips existing files in dst", () => {
    const src = join(tmp, "src");
    const dst = join(tmp, "dst");
    mkdirSync(src); mkdirSync(dst);
    writeFileSync(join(src, "a.md"), "new");
    writeFileSync(join(dst, "a.md"), "old");
    const count = syncDir(src, dst);
    expect(count).toBe(0);
    expect(readFileSync(join(dst, "a.md"), "utf8")).toBe("old");
  });

  it("handles nested directories", () => {
    const src = join(tmp, "src", "sub");
    const dst = join(tmp, "dst");
    mkdirSync(src, { recursive: true });
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(src, "deep.md"), "nested");
    const count = syncDir(join(tmp, "src"), dst);
    expect(count).toBe(1);
    expect(existsSync(join(dst, "sub", "deep.md"))).toBe(true);
  });

  it("copies multiple files", () => {
    const src = join(tmp, "src");
    const dst = join(tmp, "dst");
    mkdirSync(src); mkdirSync(dst);
    writeFileSync(join(src, "a.md"), "1");
    writeFileSync(join(src, "b.md"), "2");
    writeFileSync(join(src, "c.md"), "3");
    expect(syncDir(src, dst)).toBe(3);
  });

  it("returns 0 for empty source dir", () => {
    const src = join(tmp, "src");
    mkdirSync(src);
    expect(syncDir(src, join(tmp, "dst"))).toBe(0);
  });
});

// ─── syncOracleVaults ───────────────────────────────────────────────────────

describe("syncOracleVaults", () => {
  it("syncs learnings between oracle vaults", () => {
    const from = join(tmp, "from", "ψ", "memory", "learnings");
    const to = join(tmp, "to", "ψ", "memory", "learnings");
    mkdirSync(from, { recursive: true });
    mkdirSync(to, { recursive: true });
    writeFileSync(join(from, "pattern.md"), "learned something");
    const result = syncOracleVaults(join(tmp, "from"), join(tmp, "to"), "oracle-a", "oracle-b");
    expect(result.total).toBe(1);
    expect(result.from).toBe("oracle-a");
    expect(result.to).toBe("oracle-b");
    expect(result.synced["memory/learnings"]).toBe(1);
  });

  it("returns 0 total when nothing to sync", () => {
    mkdirSync(join(tmp, "from", "ψ"), { recursive: true });
    mkdirSync(join(tmp, "to", "ψ"), { recursive: true });
    const result = syncOracleVaults(join(tmp, "from"), join(tmp, "to"), "a", "b");
    expect(result.total).toBe(0);
    expect(Object.keys(result.synced)).toHaveLength(0);
  });

  it("writes sync log when files are synced", () => {
    const from = join(tmp, "from", "ψ", "memory", "retrospectives");
    const to = join(tmp, "to", "ψ", "memory", "retrospectives");
    mkdirSync(from, { recursive: true });
    mkdirSync(to, { recursive: true });
    writeFileSync(join(from, "retro.md"), "session notes");
    syncOracleVaults(join(tmp, "from"), join(tmp, "to"), "src", "dst");
    const logPath = join(tmp, "to", "ψ", ".soul-sync", "sync.log");
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("src → dst");
    expect(log).toContain("1 files");
  });

  it("syncs across multiple SYNC_DIRS", () => {
    const dirs = ["memory/learnings", "memory/retrospectives"];
    for (const d of dirs) {
      mkdirSync(join(tmp, "from", "ψ", d), { recursive: true });
      mkdirSync(join(tmp, "to", "ψ", d), { recursive: true });
      writeFileSync(join(tmp, "from", "ψ", d, "file.md"), d);
    }
    const result = syncOracleVaults(join(tmp, "from"), join(tmp, "to"), "a", "b");
    expect(result.total).toBe(2);
  });
});

// ─── syncProjectVault ───────────────────────────────────────────────────────

describe("syncProjectVault", () => {
  it("syncs project learnings to oracle vault", () => {
    const proj = join(tmp, "project", "ψ", "memory", "learnings");
    const orc = join(tmp, "oracle", "ψ", "memory", "learnings");
    mkdirSync(proj, { recursive: true });
    mkdirSync(orc, { recursive: true });
    writeFileSync(join(proj, "insight.md"), "project insight");
    const result = syncProjectVault(join(tmp, "project"), join(tmp, "oracle"), "my-project", "neo");
    expect(result.total).toBe(1);
    expect(result.project).toBe("my-project");
    expect(result.oracle).toBe("neo");
    expect(result.synced["memory/learnings"]).toBe(1);
  });

  it("returns 0 when project vault is empty", () => {
    mkdirSync(join(tmp, "project", "ψ"), { recursive: true });
    mkdirSync(join(tmp, "oracle", "ψ"), { recursive: true });
    const result = syncProjectVault(join(tmp, "project"), join(tmp, "oracle"), "proj", "orc");
    expect(result.total).toBe(0);
  });

  it("writes sync log with project prefix", () => {
    const proj = join(tmp, "project", "ψ", "memory", "learnings");
    const orc = join(tmp, "oracle", "ψ", "memory", "learnings");
    mkdirSync(proj, { recursive: true });
    mkdirSync(orc, { recursive: true });
    writeFileSync(join(proj, "note.md"), "data");
    syncProjectVault(join(tmp, "project"), join(tmp, "oracle"), "my-repo", "neo");
    const logPath = join(tmp, "oracle", "ψ", ".soul-sync", "sync.log");
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("project:my-repo");
  });
});
