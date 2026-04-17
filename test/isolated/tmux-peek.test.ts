import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";

// Test resolveTmuxTarget in isolation — it's a pure function that resolves
// user-supplied targets to tmux pane identifiers. hostExec is NOT exercised
// here (integration-only path — documented gap).

// We import via dynamic import after redirecting TEAMS_DIR via override env var.
// Since TEAMS_DIR is a const initialized from homedir(), we instead patch by
// creating the real ~/.claude/teams/ path during setup. Because tests run
// in-process, we need a different approach: write fake team configs to the
// ACTUAL ~/.claude/teams/ path under a unique team name we clean up.

let testTeamDir: string;

beforeEach(() => {
  const teamName = `tmux-peek-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  testTeamDir = join(homedir(), ".claude/teams", teamName);
  mkdirSync(testTeamDir, { recursive: true });
  writeFileSync(join(testTeamDir, "config.json"), JSON.stringify({
    name: teamName,
    members: [
      { name: "known-agent", tmuxPaneId: "%999", agentType: "general-purpose" },
      { name: "orphan-agent", tmuxPaneId: "", agentType: "general-purpose" },
      { name: "lead",         tmuxPaneId: "", agentType: "team-lead" },
    ],
  }));
});

afterEach(() => {
  try { rmSync(testTeamDir, { recursive: true, force: true }); } catch { /* ok */ }
});

describe("resolveTmuxTarget — target resolution", () => {
  test("pane ID literal is returned as-is", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/plugins/tmux/impl");
    const hit = resolveTmuxTarget("%776");
    expect(hit).toEqual({ resolved: "%776", source: "pane-id" });
  });

  test("session:w.p format is passed through", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/plugins/tmux/impl");
    const hit = resolveTmuxTarget("101-mawjs:0.1");
    expect(hit).toEqual({ resolved: "101-mawjs:0.1", source: "session:w.p" });
  });

  test("team-agent name resolves via team config walk (Bug D fix)", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/plugins/tmux/impl");
    const hit = resolveTmuxTarget("known-agent");
    expect(hit?.resolved).toBe("%999");
    expect(hit?.source).toContain("team-agent");
  });

  test("team-agent with empty tmuxPaneId falls through to session-name fallback", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/plugins/tmux/impl");
    const hit = resolveTmuxTarget("orphan-agent");
    // orphan-agent has tmuxPaneId="" — skipped as not-live, falls to session fallback
    expect(hit?.resolved).toBe("orphan-agent:0");
    expect(hit?.source).toContain("session-name");
  });

  test("bare session name → session:0 fallback", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/plugins/tmux/impl");
    const hit = resolveTmuxTarget("112-fusion");
    expect(hit?.resolved).toBe("112-fusion:0");
    expect(hit?.source).toContain("session-name");
  });

  test("target resolution is deterministic — same input, same output", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/plugins/tmux/impl");
    const a = resolveTmuxTarget("known-agent");
    const b = resolveTmuxTarget("known-agent");
    expect(a).toEqual(b);
  });

  test("unknown name that looks like session produces fallback (no false-positive match)", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/plugins/tmux/impl");
    // Not a team-agent name (not in any config), not a pane-id pattern — fallback to session.
    const hit = resolveTmuxTarget("zzz-nonexistent");
    expect(hit?.resolved).toBe("zzz-nonexistent:0");
  });
});
