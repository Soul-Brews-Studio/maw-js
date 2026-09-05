/**
 * Regression: `maw wake --work` into a repo whose owner agent is live must
 * not launch with the engine's `--continue` form — that resumes the newest
 * conversation for the cwd, i.e. it forks the live owner's session.
 *
 * Origin: Riddler MAW backlog note 2026-08-17 (crooclose respawn relay):
 * "maw wake --work on same repo/session can fork/resume a live owner session."
 *
 * Tests the pure classifier ownerAgentPaneInCwd: same-cwd live agent panes
 * (including via symlinked paths) are detected; shells and other dirs are not.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerAgentPaneInCwd } from "../../src/commands/shared/wake-cmd.ts";

describe("ownerAgentPaneInCwd", () => {
  const id = (p: string) => p; // identity realpath for the pure cases

  test("detects a live agent pane in the same cwd", () => {
    const owner = ownerAgentPaneInCwd("/repo/a", [
      { target: "05-x:shell.1", command: "zsh", cwd: "/repo/a" },
      { target: "04-croo:croo-oracle.1", command: "claude", cwd: "/repo/a" },
    ], id);
    expect(owner).toBe("04-croo:croo-oracle.1");
  });

  test("ignores shells and agents in other directories", () => {
    const owner = ownerAgentPaneInCwd("/repo/a", [
      { target: "05-x:shell.1", command: "bash", cwd: "/repo/a" },
      { target: "06-y:agent.1", command: "claude", cwd: "/repo/b" },
      { target: "07-z:empty.1", command: "claude" },
    ], id);
    expect(owner).toBeNull();
  });

  test("matches through symlinked checkout paths (ghq symlink vs real dir)", () => {
    const base = mkdtempSync(join(tmpdir(), "maw-fork-guard-"));
    try {
      const real = join(base, "real-repo");
      const link = join(base, "ghq-link");
      mkdirSync(real);
      symlinkSync(real, link);
      const owner = ownerAgentPaneInCwd(link, [
        { target: "04-croo:croo-oracle.1", command: "claude", cwd: real },
      ]);
      expect(owner).toBe("04-croo:croo-oracle.1");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("empty pane list is safe", () => {
    expect(ownerAgentPaneInCwd("/repo/a", [], id)).toBeNull();
  });
});
