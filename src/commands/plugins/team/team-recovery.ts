import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { hostExec } from "../../../sdk";
import { TEAMS_DIR, loadTeam, resolvePsi } from "./team-helpers";
import type { AgentColor } from "../../core/tmux/layout-manager";

const MAW_TEAMS_DIR = join(homedir(), ".maw/teams");

interface SavedMember {
  name: string;
  tmuxPaneId: string;
  cwd: string;
  agentType: string;
  backendType: string;
  color: string;
  model: string;
  agentId: string;
}

interface TeamSaveEntry {
  ts: string;
  type: "team_save";
  team: string;
  members: SavedMember[];
}

interface TeamResumeEntry {
  ts: string;
  type: "team_resume";
  team: string;
  recovered: number;
  result: "success" | "partial" | "failed";
}

function jsonlPath(teamName: string): string {
  return join(MAW_TEAMS_DIR, `${teamName}.jsonl`);
}

export function hasSavedSession(teamName: string): boolean {
  const path = jsonlPath(teamName);
  if (!existsSync(path)) return false;
  const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]!);
      if (entry.type === "team_save") return true;
    } catch { /* skip malformed */ }
  }
  return false;
}

function readLastSave(teamName: string): TeamSaveEntry | null {
  const path = jsonlPath(teamName);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]!);
      if (entry.type === "team_save") return entry as TeamSaveEntry;
    } catch { /* skip malformed */ }
  }
  return null;
}

export async function cmdTeamSave(teamName: string): Promise<void> {
  const team = loadTeam(teamName);
  if (!team) throw new Error(`team not found: ${teamName}`);

  mkdirSync(MAW_TEAMS_DIR, { recursive: true });

  const members: SavedMember[] = [];
  for (const m of team.members) {
    let cwd = "";
    if (m.tmuxPaneId && m.tmuxPaneId !== "in-process") {
      try {
        cwd = (await hostExec(`tmux display -p -t '${m.tmuxPaneId}' '#{pane_current_path}'`)).trim();
      } catch { /* pane may be dead */ }
    }
    members.push({
      name: m.name,
      tmuxPaneId: m.tmuxPaneId || "",
      cwd,
      agentType: m.agentType || "general-purpose",
      backendType: m.backendType || "claude",
      color: m.color || "blue",
      model: m.model || "sonnet",
      agentId: m.agentId || `${m.name}@${teamName}`,
    });
  }

  const entry: TeamSaveEntry = {
    ts: new Date().toISOString(),
    type: "team_save",
    team: teamName,
    members,
  };
  appendFileSync(jsonlPath(teamName), JSON.stringify(entry) + "\n");

  console.log(`\x1b[32m✓\x1b[0m saved session for team '${teamName}' — ${members.length} member(s)`);
  console.log(`  \x1b[90m${jsonlPath(teamName)}\x1b[0m`);
}

export async function cmdTeamSessionResume(teamName: string, opts: { model?: string } = {}): Promise<void> {
  const save = readLastSave(teamName);
  if (!save) {
    throw new Error(`no saved session for '${teamName}' — run: maw team save ${teamName}`);
  }

  const alivePanes = new Set(
    (await hostExec("tmux list-panes -a -F '#{pane_id}'")).split("\n").filter(Boolean),
  );

  const { spawnTeammatePane, colorAnsi } = await import("../../core/tmux/layout-manager");
  const PSI = resolvePsi();

  let recovered = 0;
  let colorIndex = 0;

  for (const m of save.members) {
    if (m.agentType === "team-lead") { colorIndex++; continue; }

    if (alivePanes.has(m.tmuxPaneId)) {
      console.log(`  \x1b[${colorAnsi(m.color as AgentColor)}m●\x1b[0m ${m.agentId} alive (${m.tmuxPaneId})`);
      colorIndex++;
      continue;
    }

    const model = opts.model || m.model || "sonnet";
    const promptPath = join(PSI, "memory", "mailbox", "teams", teamName, `${m.name}-spawn-prompt.md`);
    const envPrefix = "CLAUDECODE=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1";
    const claudeCmd = [
      envPrefix,
      "claude",
      `--agent-id '${m.agentId}'`,
      `--agent-name '${m.name}'`,
      `--team-name '${teamName}'`,
      `--agent-color ${m.color}`,
      `--agent-type ${m.agentType}`,
      "--dangerously-skip-permissions",
      `--model ${model}`,
      existsSync(promptPath) ? `--system-prompt-file '${promptPath.replace(/'/g, "'\\''")}'` : "",
    ].filter(Boolean).join(" ");

    const fullCmd = m.cwd ? `cd '${m.cwd.replace(/'/g, "'\\''")}' && ${claudeCmd}` : claudeCmd;

    try {
      const result = await spawnTeammatePane(m.name, fullCmd, { colorIndex });

      // Update tool store with new pane ID
      const toolConfigPath = join(TEAMS_DIR, teamName, "config.json");
      if (existsSync(toolConfigPath)) {
        try {
          const toolConfig = JSON.parse(readFileSync(toolConfigPath, "utf-8"));
          const member = toolConfig.members?.find((tm: { name: string }) => tm.name === m.name);
          if (member) {
            member.tmuxPaneId = result.paneId;
            writeFileSync(toolConfigPath, JSON.stringify(toolConfig, null, 2));
          }
        } catch { /* best effort */ }
      }

      await hostExec(`tmux send-keys -t '${result.paneId}' '/recap --deep' Enter`);

      console.log(`  \x1b[${colorAnsi(result.color)}m↻\x1b[0m ${m.agentId} restored → ${result.paneId}`);
      recovered++;
    } catch (e) {
      console.error(`  \x1b[31m✗\x1b[0m failed to restore ${m.agentId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    colorIndex++;
  }

  const resumeEntry: TeamResumeEntry = {
    ts: new Date().toISOString(),
    type: "team_resume",
    team: teamName,
    recovered,
    result: recovered > 0 ? "success" : "failed",
  };
  appendFileSync(jsonlPath(teamName), JSON.stringify(resumeEntry) + "\n");

  console.log(`\x1b[32m✓\x1b[0m resumed team '${teamName}' — ${recovered} pane(s) restored`);
}
