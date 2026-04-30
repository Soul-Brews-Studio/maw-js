import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmux } from "../../../sdk";
import { TEAMS_DIR, loadTeam, resolvePsi } from "./team-helpers";
import { findZombiePanes } from "./team-cleanup-zombies";

// Re-export everything so index.ts and tests continue to import from "./impl"
export { _setDirs, loadTeam, writeShutdownRequest, writeMessage } from "./team-helpers";
export { cmdTeamShutdown, cmdTeamCreate, cmdTeamSpawn, mergeTeamKnowledge } from "./team-lifecycle";
export { cmdTeamSend } from "./team-comms";
export { cmdTeamResume, cmdTeamLives } from "./team-reincarnation";
export { cmdCleanupZombies } from "./team-cleanup-zombies";

/**
 * Scan vault for CLI-created team manifests (#393 Bug B).
 * Returns list of {name, members[]} that are NOT also present in the tool store.
 */
function listVaultOnlyTeams(toolTeamNames: Set<string>): Array<{ name: string; members: string[] }> {
  const vaultTeamsDir = join(resolvePsi(), "memory", "mailbox", "teams");
  if (!existsSync(vaultTeamsDir)) return [];
  const out: Array<{ name: string; members: string[] }> = [];
  try {
    for (const name of readdirSync(vaultTeamsDir)) {
      if (toolTeamNames.has(name)) continue; // also in tool store — listed via main loop
      const manifestPath = join(vaultTeamsDir, name, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
        const members = Array.isArray(raw?.members)
          ? raw.members.map((m: any) => typeof m === "string" ? m : m?.name).filter(Boolean)
          : [];
        out.push({ name, members });
      } catch { /* skip malformed manifest */ }
    }
  } catch { /* no vault teams dir */ }
  return out;
}

// ─── maw team list ───

export async function cmdTeamList() {
  let teamDirs: string[] = [];
  try {
    teamDirs = readdirSync(TEAMS_DIR).filter(d =>
      existsSync(join(TEAMS_DIR, d, "config.json"))
    );
  } catch { /* expected: teams dir may not exist */ }

  // #393 Bug B: also surface vault-only teams (created via maw team create
  // but never wired through the tool-layer Agent()). They don't have pane
  // IDs, but they exist and can be resumed.
  const vaultOnly = listVaultOnlyTeams(new Set(teamDirs));

  if (!teamDirs.length && !vaultOnly.length) {
    console.log("\x1b[90mNo teams found.\x1b[0m");
    console.log("\x1b[90m  looked in: ~/.claude/teams/ (tool) + ψ/memory/mailbox/teams/ (vault)\x1b[0m");
    return;
  }

  const panes = await tmux.listPaneIds();

  console.log();
  console.log(`  \x1b[36;1mTEAM${" ".repeat(26)}STORE  MEMBERS  STATUS          ZOMBIES\x1b[0m`);

  for (const dir of teamDirs) {
    const team = loadTeam(dir);
    if (!team) continue;

    const teammates = team.members.filter(m => m.agentType !== "team-lead");
    const aliveMembers = team.members.filter(m =>
      m.tmuxPaneId && m.tmuxPaneId !== "in-process" && m.tmuxPaneId !== "" && panes.has(m.tmuxPaneId)
    );
    const deadPanes = teammates.filter(m =>
      m.tmuxPaneId && m.tmuxPaneId !== "in-process" && m.tmuxPaneId !== "" && !panes.has(m.tmuxPaneId)
    );

    const name = dir.padEnd(30);
    const store = "tool".padEnd(7);
    const memberCount = String(teammates.length).padEnd(9);
    const idle = aliveMembers.filter(m => m.agentType !== "team-lead").length;
    const status = aliveMembers.length > 0
      ? `\x1b[32m${idle} alive\x1b[0m`.padEnd(26)
      : `\x1b[90mno live panes\x1b[0m`.padEnd(26);

    console.log(`  ${name}${store}${memberCount}${status}${deadPanes.length > 0 ? `\x1b[90m${deadPanes.length} exited\x1b[0m` : "0"}`);
  }

  for (const v of vaultOnly) {
    const name = v.name.padEnd(30);
    const store = "vault".padEnd(7);
    const memberCount = String(v.members.length).padEnd(9);
    const status = `\x1b[90mprep-only\x1b[0m`.padEnd(26);
    console.log(`  ${name}${store}${memberCount}${status}\x1b[90m—\x1b[0m`);
  }

  if (vaultOnly.length > 0) {
    console.log(`\n  \x1b[90m${vaultOnly.length} vault-only team(s) — resume via \x1b[36mmaw team resume <name>\x1b[90m or remove via \x1b[36mrm -rf ψ/memory/mailbox/teams/<name>/\x1b[0m`);
  }

  // Check for orphan zombie panes (panes running claude with no matching team)
  const allPanes = await tmux.listPanes();
  const zombies = findZombiePanes(allPanes);
  if (zombies.length > 0) {
    console.log(`\n  \x1b[33m⚠ ${zombies.length} orphan zombie pane(s) detected\x1b[0m — run \x1b[36mmaw cleanup --zombie-agents\x1b[0m`);
  }

  console.log();
}
