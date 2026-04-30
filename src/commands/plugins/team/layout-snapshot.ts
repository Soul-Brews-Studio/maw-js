import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { TEAMS_DIR, loadTeam } from "./team-helpers";
import type { AgentColor } from "../tmux/layout-manager";

export interface PaneSnapshot {
  name: string;
  agentId: string;
  tmuxPaneId: string;
  color: AgentColor;
  command?: string;
}

export interface LayoutSnapshot {
  teamName: string;
  leaderPane: string;
  layout: string;
  panes: PaneSnapshot[];
  savedAt: number;
}

function snapshotPath(teamName: string): string {
  return join(TEAMS_DIR, teamName, "layout.json");
}

export function saveLayoutSnapshot(teamName: string, leaderPane: string, layout = "main-vertical"): void {
  const team = loadTeam(teamName);
  if (!team) return;

  const panes: PaneSnapshot[] = team.members
    .filter(m => m.tmuxPaneId && m.agentType !== "team-lead")
    .map(m => ({
      name: m.name,
      agentId: m.agentId || `${m.name}@${teamName}`,
      tmuxPaneId: m.tmuxPaneId!,
      color: (m.color as AgentColor) || "blue",
    }));

  const snapshot: LayoutSnapshot = {
    teamName,
    leaderPane,
    layout,
    panes,
    savedAt: Date.now(),
  };

  const dir = join(TEAMS_DIR, teamName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(snapshotPath(teamName), JSON.stringify(snapshot, null, 2));
}

export function loadLayoutSnapshot(teamName: string): LayoutSnapshot | null {
  const path = snapshotPath(teamName);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch { return null; }
}
