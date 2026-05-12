import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import type { AgentColor } from "../tmux/layout-manager";
import type { TeamConfig, TeamMember } from "../team/team-helpers";
import { parseFlags } from "../../../cli/parse-args";
import { ENGINE_DEFS, ENGINE_NAMES, resolveEngine, buildEngineCommand } from "../../shared/engines";
import type { EngineName } from "../../shared/engines";

export const command = {
  name: "arena",
  description: "Engine arena — same prompt, multiple engines, compare side by side.",
};

const DEFAULT_ENGINES: EngineName[] = ["claude", "codex", "gemini"];

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };

  try {
    if (!process.env.TMUX) {
      console.log("\x1b[33m⚠\x1b[0m arena requires tmux");
      return { ok: false, error: "not in tmux" };
    }

    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const flags = parseFlags(args, {
      "--engines": String,
      "--tiled": Boolean,
      "--help": Boolean, "-h": "--help",
    }, 0);

    if (flags["--help"]) {
      console.log('usage: maw arena "<prompt>" [--engines engine1,engine2,...] [--tiled]');
      console.log("");
      console.log('  maw arena "fix this bug"                        claude,codex,gemini (default)');
      console.log('  maw arena "explain this" --engines claude,gemini  two engines');
      console.log('  maw arena "refactor" --tiled                    equal layout');
      console.log("");
      console.log(`Supported engines: ${ENGINE_NAMES.join(", ")}`);
      return { ok: true, output: logs.join("\n") };
    }

    const tiled = !!flags["--tiled"];
    const positional = flags._ as string[];
    const prompt = positional.join(" ").trim();

    if (!prompt) {
      console.log('\x1b[33m⚠\x1b[0m arena requires a prompt: maw arena "your prompt here"');
      return { ok: false, error: "missing prompt" };
    }

    const enginesRaw = (flags["--engines"] as string) || DEFAULT_ENGINES.join(",");
    let engineList: EngineName[];
    try {
      engineList = enginesRaw.split(",").map(e => resolveEngine(e.trim()));
    } catch (e: unknown) {
      console.log(`\x1b[31m✗\x1b[0m ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    if (engineList.length > 10) {
      console.log("\x1b[33m⚠\x1b[0m max 10 engines");
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

    // Write prompt files to ~/.maw/arena/<timestamp>/
    const timestamp = Date.now();
    const promptDir = join(homedir(), ".maw", "arena", String(timestamp));
    mkdirSync(promptDir, { recursive: true });

    const anchor = process.env.TMUX_PANE ?? "";
    const teamName = "arena";
    const teamsDir = join(homedir(), ".claude/teams");
    const teamDir = join(teamsDir, teamName);
    const configPath = join(teamDir, "config.json");

    mkdirSync(teamDir, { recursive: true });
    let config: TeamConfig;
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } else {
      config = { name: teamName, description: "Engine arena — same prompt, multiple engines", members: [], createdAt: Date.now() };
    }

    const paneInfos: {
      engine: EngineName;
      name: string;
      agentId: string;
      label: string;
      color: AgentColor;
      cmd: string;
    }[] = [];

    for (let i = 0; i < engineList.length; i++) {
      const engine = engineList[i];
      const def = ENGINE_DEFS[engine];
      const name = `${engine}-${i + 1}`;
      const color = nextAgentColor(i);
      const agentId = `${name}@${teamName}`;
      const promptPath = join(promptDir, `${engine}.prompt.md`);

      writeFileSync(promptPath, prompt, "utf-8");

      let cmd: string;
      if (engine === "claude") {
        const escapedPath = promptPath.replace(/'/g, "'\\''");
        cmd = `claude --dangerously-skip-permissions --model ${def.defaultModel} -p "$(cat '${escapedPath}')"`;
      } else {
        cmd = buildEngineCommand(engine, { promptPath });
      }

      paneInfos.push({ engine, name, agentId, label: engine, color, cmd });
    }

    // Phase 1: Split placeholder panes — sleep, no shell init, immune to SIGWINCH
    const spawned: (typeof paneInfos[number] & { paneId: string })[] = [];
    for (const info of paneInfos) {
      const targetFlag = anchor ? `-t '${anchor}' ` : "";
      let paneId = "";
      await withPaneLock(async () => {
        paneId = (await hostExec(
          `tmux split-window ${targetFlag}-h -P -F '#{pane_id}' 'sleep infinity'`,
        )).trim();
        await new Promise(r => setTimeout(r, 100));
      });
      spawned.push({ ...info, paneId });
    }

    // Phase 2: Apply layout ONCE — all panes get their final sizes
    const window = await getWindowTarget();
    if (tiled) {
      await applyTiledLayout(window);
    } else if (anchor) {
      await applyTeamLayout(window, anchor);
    }
    await enableBorderStatus(window);
    await new Promise(r => setTimeout(r, 200));

    // Phase 3: Respawn panes with real shell + engine command
    for (const agent of spawned) {
      await stylePaneBorder(agent.paneId, `${agent.name} (${agent.label})`, agent.color);

      const escaped = agent.cmd.replace(/'/g, "'\\''");
      await hostExec(
        `tmux respawn-pane -k -t '${agent.paneId}' '${PANE_INIT_PRELUDE}; ${escaped}; stty sane 2>/dev/null; printf "\\e[?1049l\\e[0m"; clear; exec zsh -li'`,
      );
      await new Promise(r => setTimeout(r, 200));

      const entry = {
        name: agent.name,
        agentId: agent.agentId,
        tmuxPaneId: agent.paneId,
        color: agent.color,
        model: ENGINE_DEFS[agent.engine].binary,
      };
      const existing = config.members.findIndex((m: TeamMember) => m.name === agent.name);
      if (existing >= 0) config.members[existing] = entry;
      else config.members.push(entry);

      console.log(`  \x1b[${colorAnsi(agent.color)}m●\x1b[0m ${agent.name} (${agent.label}) → ${agent.paneId}`);
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const { saveLayoutSnapshot } = await import("../team/layout-snapshot");
    saveLayoutSnapshot(teamName, anchor);

    console.log(`\x1b[32m✓\x1b[0m arena: ${engineList.length} engines (${tiled ? "tiled" : "main-vertical"})`);
    console.log(`\x1b[90m  prompt → ${promptDir}\x1b[0m`);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
  }
}
