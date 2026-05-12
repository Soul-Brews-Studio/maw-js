import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import type { AgentColor } from "../tmux/layout-manager";
import type { TeamConfig, TeamMember } from "../team/team-helpers";
import { parseFlags } from "../../../cli/parse-args";

export const command = {
  name: "swarm",
  description: "Spawn multi-AI agent panes — claude, codex, opencode side by side.",
};

const KNOWN_AGENTS: Record<string, { cmd: string; label: string }> = {
  claude:   { cmd: "claude",   label: "Claude Code" },
  codex:    { cmd: "codex",    label: "Codex CLI" },
  opencode: { cmd: "opencode", label: "OpenCode" },
  aider:    { cmd: "aider",    label: "Aider" },
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };

  try {
    if (!process.env.TMUX) {
      console.log("\x1b[33m⚠\x1b[0m swarm requires tmux");
      return { ok: false, error: "not in tmux" };
    }

    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const flags = parseFlags(args, {
      "--tiled": Boolean,
      "--count": Number,
      "--help": Boolean, "-h": "--help",
    }, 0);

    if (flags["--help"]) {
      console.log("usage: maw swarm [agents...] [--tiled] [--count N]");
      console.log("");
      console.log("  maw swarm                         3 claude agents (default)");
      console.log("  maw swarm claude codex opencode    one of each");
      console.log("  maw swarm codex codex codex        3 codex agents");
      console.log("  maw swarm --count 5                5 claude agents");
      console.log("  maw swarm --tiled                  equal layout");
      console.log("");
      console.log("Supported: claude, codex, opencode, aider, or any command");
      return { ok: true, output: logs.join("\n") };
    }

    const tiled = !!flags["--tiled"];
    const positional = flags._ as string[];

    let agentList: string[];
    if (positional.length > 0) {
      agentList = positional;
    } else {
      const count = (flags["--count"] as number) || 3;
      agentList = Array(count).fill("claude");
    }

    if (agentList.length > 10) {
      console.log("\x1b[33m⚠\x1b[0m max 10 agents");
      return { ok: false, error: "max 10" };
    }

    const {
      nextAgentColor, colorAnsi, stylePaneBorder, enableBorderStatus,
      applyTeamLayout, applyTiledLayout, getWindowTarget,
    } = await import("../tmux/layout-manager");
    const { hostExec, withPaneLock } = await import("../../../sdk");
    const { PANE_INIT_PRELUDE } = await import("../../shared/pane-prelude");
    const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");

    const anchor = process.env.TMUX_PANE ?? "";
    const teamName = "swarm";
    const teamsDir = join(homedir(), ".claude/teams");
    const teamDir = join(teamsDir, teamName);
    const configPath = join(teamDir, "config.json");

    mkdirSync(teamDir, { recursive: true });
    let config: TeamConfig;
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } else {
      config = { name: teamName, description: "Multi-AI swarm", members: [], createdAt: Date.now() };
    }

    const { loadConfig } = await import("../../../config");
    const configCommands = loadConfig().commands || {};

    const paneIds: { name: string; agentId: string; agentCmd: string; label: string; color: AgentColor }[] = [];
    for (let i = 0; i < agentList.length; i++) {
      const agentType = agentList[i];
      const known = KNOWN_AGENTS[agentType];
      const fromConfig = configCommands[agentType];
      const agentCmd = fromConfig || (known ? known.cmd : agentType);
      const label = known ? known.label : agentType;
      const name = `${agentType}-${i + 1}`;
      const color = nextAgentColor(i);
      const agentId = `${name}@${teamName}`;

      paneIds.push({ name, agentId, agentCmd, label, color });
    }

    // Phase 1: Split placeholder panes — sleep, no shell init, immune to SIGWINCH
    const spawned: { name: string; agentId: string; agentCmd: string; label: string; color: AgentColor; paneId: string }[] = [];
    for (const agent of paneIds) {
      const targetFlag = anchor ? `-t '${anchor}' ` : "";
      let paneId = "";
      await withPaneLock(async () => {
        paneId = (await hostExec(
          `tmux split-window ${targetFlag}-h -P -F '#{pane_id}' 'sleep infinity'`,
        )).trim();
        await new Promise(r => setTimeout(r, 100));
      });
      spawned.push({ ...agent, paneId });
    }

    // Phase 2: Apply layout ONCE — all panes get their final sizes (only sleep is running)
    const window = await getWindowTarget();
    if (tiled) {
      await applyTiledLayout(window);
    } else if (anchor) {
      await applyTeamLayout(window, anchor);
    }
    await enableBorderStatus(window);
    await new Promise(r => setTimeout(r, 200));

    // Phase 3: Respawn panes with real shell + agent — shell inits at final pane size
    for (const agent of spawned) {
      await stylePaneBorder(agent.paneId, `${agent.name} (${agent.label})`, agent.color);

      const escaped = agent.agentCmd.replace(/'/g, "'\\''");
      await hostExec(
        `tmux respawn-pane -k -t '${agent.paneId}' '${PANE_INIT_PRELUDE}; ${escaped}; stty sane 2>/dev/null; printf "\\e[?1049l\\e[0m"; clear; exec zsh -li'`,
      );
      await new Promise(r => setTimeout(r, 200));

      const existing = config.members.findIndex((m: TeamMember) => m.name === agent.name);
      const entry = { name: agent.name, agentId: agent.agentId, tmuxPaneId: agent.paneId, color: agent.color, model: agent.agentCmd };
      if (existing >= 0) config.members[existing] = entry;
      else config.members.push(entry);

      console.log(`  \x1b[${colorAnsi(agent.color)}m●\x1b[0m ${agent.name} (${agent.label}) → ${agent.paneId}`);
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const { saveLayoutSnapshot } = await import("../team/layout-snapshot");
    saveLayoutSnapshot(teamName, anchor);

    console.log(`\x1b[32m✓\x1b[0m swarm: ${agentList.length} agents (${tiled ? "tiled" : "main-vertical"})`);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
  }
}
