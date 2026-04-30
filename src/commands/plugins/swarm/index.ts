import type { InvokeContext, InvokeResult } from "../../../plugin/types";
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
  console.log = (...a: any[]) => {
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
    const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");

    const anchor = process.env.TMUX_PANE ?? "";
    const teamName = "swarm";
    const teamsDir = join(homedir(), ".claude/teams");
    const teamDir = join(teamsDir, teamName);
    const configPath = join(teamDir, "config.json");

    mkdirSync(teamDir, { recursive: true });
    let config: any;
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } else {
      config = { name: teamName, description: "Multi-AI swarm", members: [], createdAt: Date.now() };
    }

    for (let i = 0; i < agentList.length; i++) {
      const agentType = agentList[i];
      const known = KNOWN_AGENTS[agentType];
      const agentCmd = known ? known.cmd : agentType;
      const label = known ? known.label : agentType;
      const name = `${agentType}-${i + 1}`;
      const color = nextAgentColor(i);
      const agentId = `${name}@${teamName}`;
      const targetFlag = anchor ? `-t '${anchor}' ` : "";

      const shellCmd = `${agentCmd}; exec zsh`;

      let paneId = "";
      await withPaneLock(async () => {
        paneId = (await hostExec(
          `tmux split-window ${targetFlag}-h -P -F '#{pane_id}' '${shellCmd.replace(/'/g, "'\\''")}'`,
        )).trim();
        await new Promise(r => setTimeout(r, 300));
      });

      await stylePaneBorder(paneId, `${name} (${label})`, color);

      const existing = config.members.findIndex((m: any) => m.name === name);
      const entry = { name, agentId, tmuxPaneId: paneId, color, model: agentType };
      if (existing >= 0) config.members[existing] = entry;
      else config.members.push(entry);

      const window = await getWindowTarget();
      if (tiled) {
        await applyTiledLayout(window);
      } else if (anchor) {
        await applyTeamLayout(window, anchor);
      }
      await enableBorderStatus(window);

      console.log(`  \x1b[${colorAnsi(color)}m●\x1b[0m ${name} (${label}) → ${paneId}`);
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const { saveLayoutSnapshot } = await import("../team/layout-snapshot");
    saveLayoutSnapshot(teamName, anchor);

    console.log(`\x1b[32m✓\x1b[0m swarm: ${agentList.length} agents (${tiled ? "tiled" : "main-vertical"})`);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
  }
}
