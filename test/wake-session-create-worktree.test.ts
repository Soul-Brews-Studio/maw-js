/**
 * createWorktree fast-forwards LOCAL default branch from origin after fetch.
 *
 * Without this, an agent's `git checkout main` inside the fresh worktree lands
 * on the stale local main ref that the primary checkout last pulled (which on
 * a §3c primary parked on a non-default integration branch can be days old) —
 * the wt-48 / PR #215 stale-base trap (thread #199, parent #181).
 *
 * Diagnosed by brew-ops 2026-05-21. This test pins the fix so a future
 * createWorktree refactor that drops the update-ref line fails loudly.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mockConfigModule } from "./helpers/mock-config";

const calls: string[] = [];
let symbolicRefReturn = "origin/main"; // default — origin/HEAD configured
let symbolicRefThrows = false;

// Spread the real sdk so untouched exports (curlFetch, runHook, …) keep working
// for tests that load after this file. bun mock.module is process-global, so
// partial mocks pollute. We override hostExec + tmux only.
const realSdk = await import("../src/sdk");
mock.module("../src/sdk", () => ({
  ...realSdk,
  hostExec: async (cmd: string): Promise<string> => {
    calls.push(cmd);
    if (cmd.includes("symbolic-ref --short refs/remotes/origin/HEAD")) {
      if (symbolicRefThrows) throw new Error("origin/HEAD not set");
      return symbolicRefReturn;
    }
    if (cmd.includes("rev-parse HEAD")) return "abc123\n";
    return "";
  },
  tmux: { ...realSdk.tmux, switchClient: async () => {} },
}));

// Full config module surface — bun mock.module is process-global, so a partial
// mock pollutes other tests. See helpers/mock-config.ts (#435).
mock.module("../src/config", () => mockConfigModule(() => ({ node: "test-node" })));

const { createWorktree } = await import("../src/commands/shared/wake-session");

describe("createWorktree — local default branch is fast-forwarded after fetch (thread #199)", () => {
  let tmpRepo: string;
  let tmpParent: string;

  beforeEach(() => {
    calls.length = 0;
    symbolicRefReturn = "origin/main";
    symbolicRefThrows = false;
    tmpRepo = mkdtempSync(join(tmpdir(), "maw-fix1-repo-"));
    tmpParent = mkdtempSync(join(tmpdir(), "maw-fix1-parent-"));
  });

  test("emits update-ref refs/heads/main refs/remotes/origin/main AFTER fetch AND BEFORE worktree add", async () => {
    await createWorktree(tmpRepo, tmpParent, "test-repo", "test-oracle", "fix1", []);

    const fetchIdx = calls.findIndex(c => c.includes("fetch origin --quiet"));
    const updateRefIdx = calls.findIndex(c =>
      c.includes("update-ref 'refs/heads/main' 'refs/remotes/origin/main'")
    );
    const worktreeAddIdx = calls.findIndex(c => c.includes("worktree add"));

    expect(fetchIdx, "fetch should be issued").toBeGreaterThanOrEqual(0);
    expect(updateRefIdx, "update-ref should be issued").toBeGreaterThanOrEqual(0);
    expect(worktreeAddIdx, "worktree add should be issued").toBeGreaterThanOrEqual(0);
    expect(updateRefIdx, "update-ref must come AFTER fetch").toBeGreaterThan(fetchIdx);
    expect(updateRefIdx, "update-ref must come BEFORE worktree add").toBeLessThan(worktreeAddIdx);
  });

  test("supports non-main default branches (origin/HEAD = origin/trunk)", async () => {
    symbolicRefReturn = "origin/trunk";

    await createWorktree(tmpRepo, tmpParent, "test-repo", "test-oracle", "fix1b", []);

    const updateRefIdx = calls.findIndex(c =>
      c.includes("update-ref 'refs/heads/trunk' 'refs/remotes/origin/trunk'")
    );
    expect(updateRefIdx, "update-ref should strip 'origin/' prefix and target local branch").toBeGreaterThanOrEqual(0);
  });

  test("no update-ref attempted when origin/HEAD is unconfigured (fall back to HEAD start-point)", async () => {
    symbolicRefThrows = true;

    await createWorktree(tmpRepo, tmpParent, "test-repo", "test-oracle", "fix1c", []);

    const fetchIdx = calls.findIndex(c => c.includes("fetch origin --quiet"));
    const updateRefIdx = calls.findIndex(c => c.includes("update-ref refs/heads/"));
    const worktreeAddIdx = calls.findIndex(c => c.includes("worktree add"));

    expect(fetchIdx, "no fetch without baseRef").toBe(-1);
    expect(updateRefIdx, "no update-ref without baseRef").toBe(-1);
    expect(worktreeAddIdx, "worktree add still fires (no -b base-arg)").toBeGreaterThanOrEqual(0);
  });

  // Cleanup tmp dirs across runs; rm is best-effort.
  test.skip("teardown", () => {
    try { rmSync(tmpRepo, { recursive: true }); } catch {}
    try { rmSync(tmpParent, { recursive: true }); } catch {}
  });
});
