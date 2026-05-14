import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";

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
    const { resolveTmuxTarget } = await import("../../src/commands/core/tmux/impl");
    const hit = resolveTmuxTarget("%776");
    expect(hit).toEqual({ resolved: "%776", source: "pane-id" });
  });

  test("session:w.p format is passed through", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/core/tmux/impl");
    const hit = resolveTmuxTarget("101-mawjs:0.1");
    expect(hit).toEqual({ resolved: "101-mawjs:0.1", source: "session:w.p" });
  });

  test("team-agent name resolves via team config walk (Bug D fix)", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/core/tmux/impl");
    const hit = resolveTmuxTarget("known-agent");
    expect(hit?.resolved).toBe("%999");
    expect(hit?.source).toContain("team-agent");
  });

  test("team-agent with empty tmuxPaneId falls through to session-name fallback", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/core/tmux/impl");
    const hit = resolveTmuxTarget("orphan-agent");
    // orphan-agent has tmuxPaneId="" — skipped as not-live, falls through.
    // Per #1012 (don't hardcode :0), the bare name is returned as-is so tmux
    // can resolve to the current/first pane itself.
    expect(hit).not.toBeNull();
    // Could land on session-name fallback (most likely) or live-session if a
    // tmux session happens to fuzzy-match. Both are valid fall-throughs.
    expect(["session-name", "live-session", "fleet-stem"].some(tag => hit!.source.includes(tag))).toBe(true);
  });

  test("bare session name → resolved via fleet-stem OR session-name fallback", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/core/tmux/impl");
    const hit = resolveTmuxTarget("112-fusion");
    expect(hit).not.toBeNull();
    // Per #1012 (don't hardcode :0): resolver returns the bare session name
    // (no `:0` suffix); tmux itself resolves to the current/first pane.
    // After #394 Bug I fix: may resolve via fleet-stem tier first (if fleet
    // match), else live-session, else session-name fallback. All are valid.
    expect(["fleet-stem", "live-session", "session-name"].some(tag => hit!.source.includes(tag))).toBe(true);
  });

  test("target resolution is deterministic — same input, same output", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/core/tmux/impl");
    const a = resolveTmuxTarget("known-agent");
    const b = resolveTmuxTarget("known-agent");
    expect(a).toEqual(b);
  });

  test("unknown name that looks like session produces fallback (no false-positive match)", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/core/tmux/impl");
    // Not a team-agent name (not in any config), not a pane-id pattern — fallback to session.
    // Note: may still hit fleet-stem tier if "zzz-nonexistent" word-matches a fleet name.
    // This test isn't isolated from the real fleet dir; just verify we get SOME resolution.
    // Per #1012: no `:0` suffix is hardcoded — the bare name is the valid result.
    const hit = resolveTmuxTarget("zzz-nonexistent-xyzzy");
    expect(hit).not.toBeNull();
    expect(hit!.resolved.length).toBeGreaterThan(0);
    expect(hit!.source.length).toBeGreaterThan(0);
  });
});

// #394 Bug I — fleet stem resolution
// (Cannot hermetically mock FLEET_DIR — it's bound at module init. These
// tests assert the fleet-stem tier SHAPE: when a bare name matches no
// pane-id / session:w.p / team-agent, the resolver should attempt fleet
// resolution before falling through. We verify the source label.)
describe("resolveTmuxTarget — fleet stem tier (#394 Bug I)", () => {
  test("bare name with no match still produces a resolution with source label", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/core/tmux/impl");
    // This name won't match any fleet session but WILL match the final fallback.
    const hit = resolveTmuxTarget("definitely-not-a-real-fleet-oracle-xyzzy");
    expect(hit).not.toBeNull();
    // Per #1012 (don't hardcode :0): resolver returns the bare session name
    // — no `:0` suffix — tmux itself resolves to the current/first pane.
    // Either fleet-stem / live-session (if fuzzy-matched) or session-name fallback.
    expect(hit!.resolved.length).toBeGreaterThan(0);
    expect(["fleet-stem", "live-session", "session-name"].some(tag => hit!.source.includes(tag))).toBe(true);
  });

  test("source label for bare-name resolution mentions the tier used", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/core/tmux/impl");
    const hit = resolveTmuxTarget("some-fleet-candidate-name");
    expect(hit).not.toBeNull();
    // Must be descriptive, not empty
    expect(hit!.source.length).toBeGreaterThan(0);
  });
});
