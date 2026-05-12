import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { hostExec } from "../../../sdk";
import { TEAMS_DIR, loadTeam, type TeamMember } from "./team-helpers";

function listTeams(): string[] {
  if (!existsSync(TEAMS_DIR)) return [];
  return readdirSync(TEAMS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
}

async function getAlivePanes(): Promise<Set<string>> {
  try {
    const out = await hostExec("tmux list-panes -a -F '#{pane_id}'");
    return new Set(out.split("\n").filter(Boolean));
  } catch { return new Set(); }
}

async function getOrphanPanes(knownPaneIds: Set<string>): Promise<Set<string>> {
  try {
    const out = await hostExec("tmux list-panes -a -F '#{pane_id} #{pane_current_command}'");
    const result = new Set<string>();
    for (const line of out.split("\n").filter(Boolean)) {
      const spaceIdx = line.indexOf(" ");
      const paneId = line.slice(0, spaceIdx);
      const cmd = line.slice(spaceIdx + 1).toLowerCase();
      if (paneId && !knownPaneIds.has(paneId) && (cmd.includes("claude") || cmd.includes("node") || cmd.includes("bun"))) {
        result.add(paneId);
      }
    }
    return result;
  } catch { return new Set(); }
}

export async function cmdTeamDoctor(opts: { fix?: boolean } = {}): Promise<void> {
  const label = opts.fix ? "🔍 Team Doctor (--fix)" : "🔍 Team Doctor";
  console.log(`\n${label}\n`);

  const teams = listTeams();
  if (teams.length === 0) {
    console.log(`\x1b[90mno teams found\x1b[0m\n`);
    return;
  }

  const alive = await getAlivePanes();

  // Build full member list and collect all known pane IDs across all teams
  const knownPaneIds = new Set<string>();
  const teamConfigs: Array<{ name: string; members: TeamMember[] }> = [];

  for (const name of teams) {
    const config = loadTeam(name);
    if (!config) continue;
    const members = config.members.filter(m => m.agentType !== "team-lead");
    teamConfigs.push({ name, members });
    for (const m of members) {
      if (m.tmuxPaneId) knownPaneIds.add(m.tmuxPaneId);
    }
  }

  const orphanPanes = await getOrphanPanes(knownPaneIds);

  let totalGhosts = 0;
  let totalFixed = 0;

  for (const { name, members } of teamConfigs) {
    const ghosts = members.filter(m => m.tmuxPaneId && !alive.has(m.tmuxPaneId));

    if (opts.fix) {
      if (ghosts.length === 0) continue;
      console.log(`${name}`);
      const configPath = join(TEAMS_DIR, name, "config.json");
      try {
        const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
        const ghostNames = new Set(ghosts.map(g => g.name));
        cfg.members = cfg.members.filter((m: TeamMember) => !ghostNames.has(m.name));
        writeFileSync(configPath, JSON.stringify(cfg, null, 2));
        for (const g of ghosts) {
          console.log(`  \x1b[32m✓\x1b[0m removed ghost: ${g.agentId || g.name} (pane ${g.tmuxPaneId || "-"})`);
          totalFixed++;
        }
      } catch {
        console.log(`  \x1b[31m✗\x1b[0m failed to update config for team ${name}`);
      }
      totalGhosts += ghosts.length;
    } else {
      console.log(`${name} (${members.length} member${members.length !== 1 ? "s" : ""})`);
      for (const m of members) {
        const paneId = m.tmuxPaneId ?? "";
        const isAlive = paneId ? alive.has(paneId) : false;
        const isGhost = paneId && !isAlive;
        const dot = isAlive ? `\x1b[32m●\x1b[0m` : `\x1b[90m·\x1b[0m`;
        const nameLabel = isAlive
          ? `\x1b[32m${m.agentId || m.name}\x1b[0m`
          : `\x1b[90m${m.agentId || m.name}\x1b[0m`;
        const status = isAlive
          ? `\x1b[32mrunning\x1b[0m`
          : isGhost
            ? `\x1b[31mghost\x1b[0m — pane dead but still in config`
            : `\x1b[90mno pane\x1b[0m`;
        console.log(`  ${dot} ${nameLabel}  ${paneId || "-"}  ${status}`);
        if (isGhost) totalGhosts++;
      }
      console.log("");
    }
  }

  if (opts.fix) {
    for (const paneId of orphanPanes) {
      try {
        await hostExec(`tmux kill-pane -t '${paneId}'`);
        console.log(`  \x1b[32m✓\x1b[0m killed orphan pane: ${paneId}`);
      } catch {
        console.log(`  \x1b[31m✗\x1b[0m failed to kill orphan pane: ${paneId}`);
      }
    }
    const orphanStr = orphanPanes.size > 0
      ? `, ${orphanPanes.size} orphan${orphanPanes.size !== 1 ? "s" : ""} killed`
      : "";
    console.log(`\nFixed: ${totalFixed} ghost${totalFixed !== 1 ? "s" : ""} removed${orphanStr}`);
  } else {
    console.log(`Summary: ${totalGhosts} ghost${totalGhosts !== 1 ? "s" : ""}, ${orphanPanes.size} orphan${orphanPanes.size !== 1 ? "s" : ""}`);
  }
  console.log("");
}
