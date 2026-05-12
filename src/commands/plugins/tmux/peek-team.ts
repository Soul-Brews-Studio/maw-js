/**
 * `maw peek --team [name]` / `maw peek --all` — peek multiple panes at once.
 *
 * --team: reads ~/.claude/teams/<name>/config.json for member pane IDs,
 *         captures each in parallel, prints stacked with agent-name headers.
 * --all:  captures every pane in the current tmux session.
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { hostExec } from "../../../sdk";

const TEAMS_DIR = join(homedir(), ".claude", "teams");

interface PeekOpts {
  teamName?: string;
  all?: boolean;
  lines: number;
  history: boolean;
}

async function capturePaneContent(paneId: string, lines: number, history: boolean): Promise<string> {
  const startFlag = history ? `-S -${lines}` : `-S -${lines}`;
  try {
    return await hostExec(`tmux capture-pane -t '${paneId}' -p ${startFlag}`);
  } catch {
    return `(pane ${paneId} not found)`;
  }
}

function loadTeamMembers(teamName: string): Array<{ name: string; tmuxPaneId?: string; color?: string }> {
  const configPath = join(TEAMS_DIR, teamName, "config.json");
  if (!existsSync(configPath)) return [];
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    return (config.members ?? []).filter((m: { agentType?: string }) => m.agentType !== "team-lead");
  } catch { return []; }
}

function findActiveTeam(): string | null {
  if (!existsSync(TEAMS_DIR)) return null;
  const teams = readdirSync(TEAMS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
  return teams.at(-1) ?? null;
}

async function getAllSessionPanes(): Promise<Array<{ id: string; title: string }>> {
  try {
    const out = await hostExec("tmux list-panes -s -F '#{pane_id}\t#{pane_title}'");
    return out.trim().split("\n").filter(Boolean).map(line => {
      const [id, ...rest] = line.split("\t");
      return { id, title: rest.join("\t") || id };
    });
  } catch { return []; }
}

export async function peekTeamPanes(opts: PeekOpts): Promise<void> {
  if (opts.all) {
    const panes = await getAllSessionPanes();
    if (panes.length === 0) {
      console.log("  no panes found in current session");
      return;
    }
    for (const pane of panes) {
      console.log(`\x1b[36;1m=== ${pane.title} (${pane.id}) ===\x1b[0m`);
      const content = await capturePaneContent(pane.id, opts.lines, opts.history);
      const trimmed = content.split("\n").filter(l => l.trim()).slice(-opts.lines);
      console.log(trimmed.join("\n"));
      console.log("");
    }
    console.log(`\x1b[90m${panes.length} panes\x1b[0m`);
    return;
  }

  const teamName = opts.teamName || findActiveTeam();
  if (!teamName) {
    console.log("  no active team found — specify: maw peek --team <name>");
    return;
  }

  const members = loadTeamMembers(teamName);
  if (members.length === 0) {
    console.log(`  team '${teamName}' has no agents`);
    return;
  }

  console.log(`\x1b[36;1mTeam: ${teamName}\x1b[0m (${members.length} agents)\n`);
  for (const m of members) {
    const paneId = m.tmuxPaneId;
    console.log(`\x1b[33m=== ${m.name} ${paneId ? `(${paneId})` : "(no pane)"} ===\x1b[0m`);
    if (!paneId) {
      console.log("  (not spawned or pane lost)\n");
      continue;
    }
    const content = await capturePaneContent(paneId, opts.lines, opts.history);
    const trimmed = content.split("\n").filter(l => l.trim()).slice(-opts.lines);
    console.log(trimmed.join("\n"));
    console.log("");
  }
}
