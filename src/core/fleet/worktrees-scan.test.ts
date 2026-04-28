/**
 * Regression test for #823 Bug C — `allWindows` dedupe.
 *
 * Pre-fix: `sessions.flatMap(s => s.windows)` collected windows across
 * sessions without deduping by name. Two sessions each containing a window
 * named "neo" produced 2 candidate entries — the resolver then surfaced a
 * phantom "ambiguous" match even though it's the same window logically.
 *
 * Test strategy: stub `find` to return one worktree path, stub
 * `git rev-parse` to return a branch, stub `listSessions` to return TWO
 * sessions with same-named windows, and assert that the dedupe collapses
 * them so the worktree resolves to "active" rather than logging an
 * ambiguous-match error.
 */
import { describe, it, expect, mock } from "bun:test";
import { join } from "path";

const root = join(import.meta.dir, "../..");

// Stub host execution: `find` returns one worktree path, `git rev-parse`
// returns a branch name, anything else returns empty.
mock.module(join(root, "core/transport/ssh"), () => ({
  hostExec: async (cmd: string) => {
    if (cmd.includes("find ") && cmd.includes(".wt-")) {
      return "/ghq/github.com/Org/foo-oracle/foo-oracle.wt-1-neo";
    }
    if (cmd.includes("rev-parse --abbrev-ref")) {
      return "agents/1-neo";
    }
    return "";
  },
  // Two sessions with identically-named "neo" windows — pre-fix this surfaces
  // as an ambiguous match (2 candidates), post-fix it dedupes to 1.
  listSessions: async () => [
    { name: "session-a", windows: [{ name: "neo", index: "1" }] },
    { name: "session-b", windows: [{ name: "neo", index: "1" }] },
  ],
}));

mock.module(join(root, "config/ghq-root"), () => ({
  getGhqRoot: () => "/ghq",
}));

// Avoid touching real fleet dir
mock.module(join(root, "core/paths"), () => ({
  FLEET_DIR: "/tmp/maw-test-nonexistent-fleet-823",
}));

const { scanWorktrees } = await import("./worktrees-scan");

describe("scanWorktrees (#823 Bug C) — dedupe windows across sessions", () => {
  it("same-named window in 2 sessions resolves cleanly (no phantom ambiguous)", async () => {
    // Capture stderr — pre-fix path emits "is ambiguous — matches 2 windows"
    const errLogs: string[] = [];
    const origErr = console.error;
    console.error = (...a: any[]) => { errLogs.push(a.map(String).join(" ")); };

    try {
      const results = await scanWorktrees();
      // Find our worktree
      const wt = results.find(r => r.name === "1-neo");
      expect(wt).toBeDefined();
      // Post-fix: dedupe collapses the 2 same-named windows to 1, resolver
      // returns exact/fuzzy → tmuxWindow set → status = "active".
      expect(wt!.status).toBe("active");
      expect(wt!.tmuxWindow).toBe("neo");

      // No ambiguous-match noise should have been printed.
      const combined = errLogs.join("\n");
      expect(combined).not.toContain("ambiguous");
    } finally {
      console.error = origErr;
    }
  });
});
