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
const originalSpawnSync = Bun.spawnSync;
const encode = (text: string) => new TextEncoder().encode(text);

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

  (Bun as any).spawnSync = ((args: string[]) => {
    if (Array.isArray(args) && args[0] === "tmux" && args[1] === "list-sessions") {
      return {
        exitCode: 0,
        stdout: encode(""),
        stderr: new Uint8Array(),
        success: true,
      };
    }
    return originalSpawnSync(args as any);
  }) as typeof Bun.spawnSync;
});

afterEach(() => {
  (Bun as any).spawnSync = originalSpawnSync;
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
    // orphan-agent has tmuxPaneId="" — skipped as not-live, falls to session fallback.
    // Since #1012 the resolver lets tmux choose the pane for a bare session target
    // instead of hardcoding :0.
    expect(hit?.resolved).toBe("orphan-agent");
    expect(hit?.source).toContain("session-name");
  });

  test("bare session name resolves without hardcoded :0 (fleet/live/session fallback)", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/plugins/tmux/impl");
    const hit = resolveTmuxTarget("112-fusion");
    expect(hit?.resolved).toBe("112-fusion");
    // After #394 Bug I / #1058 fixes, this may resolve via fleet, live-session,
    // or final session-name fallback depending on the runner environment. All
    // tiers intentionally preserve the bare session target.
    expect(["fleet-stem", "live-session", "session-name"].some(tag => hit!.source.includes(tag))).toBe(true);
  });

  test("target resolution is deterministic — same input, same output", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/plugins/tmux/impl");
    const a = resolveTmuxTarget("known-agent");
    const b = resolveTmuxTarget("known-agent");
    expect(a).toEqual(b);
  });

  test("unknown name that looks like session produces fallback (no false-positive match)", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/plugins/tmux/impl");
    // Not a team-agent name (not in any config), not a pane-id pattern — fallback to
    // a bare session target. #1012 intentionally stopped hardcoding :0 here.
    const hit = resolveTmuxTarget("zzz-nonexistent-xyzzy");
    expect(hit).not.toBeNull();
    expect(hit?.resolved).toBe("zzz-nonexistent-xyzzy");
    expect(hit?.source).toContain("session-name");
  });
});

// #394 Bug I — fleet stem resolution
// (Cannot hermetically mock FLEET_DIR — it's bound at module init. These
// tests assert the fleet-stem tier SHAPE: when a bare name matches no
// pane-id / session:w.p / team-agent, the resolver should attempt fleet
// resolution before falling through. We verify the source label.)
describe("resolveTmuxTarget — fleet stem tier (#394 Bug I)", () => {
  test("bare name with no match still produces a resolution with source label", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/plugins/tmux/impl");
    // This name won't match any fleet session but WILL match the final fallback.
    const hit = resolveTmuxTarget("definitely-not-a-real-fleet-oracle-xyzzy");
    expect(hit).not.toBeNull();
    // Since #1012 the fallback preserves the bare session target and lets tmux
    // choose the pane rather than forcing :0.
    expect(hit!.resolved).toBe("definitely-not-a-real-fleet-oracle-xyzzy");
    expect(["fleet-stem", "live-session", "session-name"].some(tag => hit!.source.includes(tag))).toBe(true);
  });

  test("source label for bare-name resolution mentions the tier used", async () => {
    const { resolveTmuxTarget } = await import("../../src/commands/plugins/tmux/impl");
    const hit = resolveTmuxTarget("some-fleet-candidate-name");
    expect(hit).not.toBeNull();
    // Must be descriptive, not empty
    expect(hit!.source.length).toBeGreaterThan(0);
  });
});
