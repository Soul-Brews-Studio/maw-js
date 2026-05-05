/**
 * Tests for agent-teams protocol flags in cmdTeamSpawn (#1149).
 *
 * Replicates the command-string building logic inline to avoid pulling in
 * filesystem/tmux dependencies. Same isolation pattern as wake-flags.test.ts.
 */
import { describe, test, expect } from "bun:test";

// ---------------------------------------------------------------------------
// Replicate the upgraded command-building logic from team-lifecycle.ts
// ---------------------------------------------------------------------------

const AGENT_COLORS = [
  "blue", "green", "yellow", "cyan", "magenta", "red", "white", "orange",
] as const;
type AgentColor = (typeof AGENT_COLORS)[number];

function nextAgentColor(index: number): AgentColor {
  return AGENT_COLORS[index % AGENT_COLORS.length];
}

interface SpawnOpts {
  model?: string;
  prompt?: string;
  type?: string;
  color?: string;
}

/**
 * Build the claude command string with agent-teams protocol flags.
 * This mirrors the upgraded logic in cmdTeamSpawn (--exec path).
 */
function buildSpawnCommand(
  teamName: string,
  role: string,
  promptPath: string,
  opts: SpawnOpts & { teammateCount?: number; parentSessionId?: string },
): { cmd: string; env: Record<string, string> } {
  const model = opts.model || "sonnet";
  const agentId = `${role}@${teamName}`;
  const agentType = opts.type || "general-purpose";
  const color = opts.color || nextAgentColor(opts.teammateCount ?? 0);
  const parentSessionId = opts.parentSessionId;

  const envVars: Record<string, string> = {
    CLAUDECODE: "1",
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
  };

  const parts: string[] = [];
  parts.push(`claude`);
  parts.push(`--agent-id ${agentId}`);
  parts.push(`--agent-name ${role}`);
  parts.push(`--team-name ${teamName}`);
  parts.push(`--agent-color ${color}`);
  if (parentSessionId) {
    parts.push(`--parent-session-id ${parentSessionId}`);
  }
  parts.push(`--agent-type ${agentType}`);
  parts.push(`--dangerously-skip-permissions`);
  parts.push(`--model ${model}`);
  parts.push(`--system-prompt-file '${promptPath.replace(/'/g, "'\\''")}'`);

  const envPrefix = Object.entries(envVars)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

  return { cmd: `env ${envPrefix} ${parts.join(" ")}`, env: envVars };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cmdTeamSpawn — agent-teams protocol flags", () => {
  const promptPath = "/home/user/.maw/teams/research/scout-spawn-prompt.md";

  test("a. default agent-type is 'general-purpose' when --type omitted", () => {
    const { cmd } = buildSpawnCommand("research", "scout", promptPath, {});
    expect(cmd).toContain("--agent-type general-purpose");
  });

  test("b. explicit --type Explore is passed through", () => {
    const { cmd } = buildSpawnCommand("research", "scout", promptPath, {
      type: "Explore",
    });
    expect(cmd).toContain("--agent-type Explore");
    expect(cmd).not.toContain("general-purpose");
  });

  test("c. agent-id is composed as role@team", () => {
    const { cmd } = buildSpawnCommand("research", "scout", promptPath, {});
    expect(cmd).toContain("--agent-id scout@research");
    expect(cmd).toContain("--agent-name scout");
    expect(cmd).toContain("--team-name research");
  });

  test("d. color rotation cycles through palette based on teammate count", () => {
    const cmd0 = buildSpawnCommand("t", "a", promptPath, { teammateCount: 0 }).cmd;
    const cmd1 = buildSpawnCommand("t", "b", promptPath, { teammateCount: 1 }).cmd;
    const cmd8 = buildSpawnCommand("t", "c", promptPath, { teammateCount: 8 }).cmd;

    expect(cmd0).toContain("--agent-color blue");    // index 0
    expect(cmd1).toContain("--agent-color green");   // index 1
    expect(cmd8).toContain("--agent-color blue");    // wraps around (8 % 8 = 0)
  });

  test("e. parent-session-id included when CLAUDE_SESSION_ID is set", () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const { cmd } = buildSpawnCommand("research", "scout", promptPath, {
      parentSessionId: sessionId,
    });
    expect(cmd).toContain(`--parent-session-id ${sessionId}`);
  });

  test("f. parent-session-id omitted when CLAUDE_SESSION_ID is absent", () => {
    const { cmd } = buildSpawnCommand("research", "scout", promptPath, {
      parentSessionId: undefined,
    });
    expect(cmd).not.toContain("--parent-session-id");
  });

  test("g. env vars CLAUDECODE=1 and CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 always present", () => {
    const { cmd, env } = buildSpawnCommand("research", "scout", promptPath, {});
    expect(env.CLAUDECODE).toBe("1");
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
    expect(cmd).toContain("env CLAUDECODE=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1");
  });

  test("h. --dangerously-skip-permissions always present", () => {
    const { cmd } = buildSpawnCommand("research", "scout", promptPath, {});
    expect(cmd).toContain("--dangerously-skip-permissions");
  });
});
