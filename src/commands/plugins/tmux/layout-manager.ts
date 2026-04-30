import { hostExec } from "../../../sdk";

// CC palette — 8 distinct colors, same order as claude-code AgentColorName
const AGENT_COLORS = [
  "blue", "green", "yellow", "cyan", "magenta", "red", "white", "orange",
] as const;
export type AgentColor = (typeof AGENT_COLORS)[number];

// tmux color names (256-color for orange which has no named equivalent)
const TMUX_COLOR: Record<AgentColor, string> = {
  blue: "blue", green: "green", yellow: "yellow", cyan: "cyan",
  magenta: "magenta", red: "red", white: "white", orange: "colour208",
};

// ANSI codes for terminal output
const ANSI_FG: Record<AgentColor, string> = {
  blue: "34", green: "32", yellow: "33", cyan: "36",
  magenta: "35", red: "31", white: "37", orange: "38;5;208",
};

export function nextAgentColor(index: number): AgentColor {
  return AGENT_COLORS[index % AGENT_COLORS.length];
}

export function colorAnsi(color: AgentColor): string {
  return ANSI_FG[color];
}

// ─── Layout ──────────────────────────────────────────────

export async function applyTeamLayout(
  windowTarget: string,
  leaderPane: string,
  leaderPct = 30,
): Promise<void> {
  await hostExec(`tmux select-layout -t '${windowTarget}' main-vertical`);
  await hostExec(`tmux resize-pane -t '${leaderPane}' -x ${leaderPct}%`);
}

export async function rebalanceAfterSpawn(
  windowTarget: string,
  leaderPane: string,
): Promise<void> {
  await applyTeamLayout(windowTarget, leaderPane);
}

// ─── Pane Borders ────────────────────────────────────────

export async function stylePaneBorder(
  paneId: string,
  agentName: string,
  color: AgentColor,
): Promise<void> {
  const tc = TMUX_COLOR[color];
  await hostExec(`tmux select-pane -t '${paneId}' -T '${agentName}'`);
  await hostExec(
    `tmux set-option -p -t '${paneId}' pane-border-format '#[fg=${tc},bold] #{pane_title}'`,
  );
  await hostExec(
    `tmux set-option -p -t '${paneId}' pane-active-border-style 'fg=${tc}'`,
  );
}

export async function enableBorderStatus(windowTarget: string): Promise<void> {
  await hostExec(`tmux set-option -w -t '${windowTarget}' pane-border-status top`);
}

// ─── Hide / Show (CC-style break-pane / join-pane) ───────

export async function hidePane(paneId: string): Promise<boolean> {
  try {
    await hostExec(`tmux break-pane -d -t '${paneId}'`);
    return true;
  } catch { return false; }
}

export async function showPane(paneId: string, targetPane: string): Promise<boolean> {
  try {
    await hostExec(`tmux join-pane -h -s '${paneId}' -t '${targetPane}'`);
    return true;
  } catch { return false; }
}

// ─── Helpers ─────────────────────────────────────────────

export async function getWindowTarget(): Promise<string> {
  return (await hostExec("tmux display-message -p '#{window_id}'")).trim();
}

export async function listPaneIds(windowTarget?: string): Promise<string[]> {
  const flag = windowTarget ? `-t '${windowTarget}'` : "";
  const raw = await hostExec(`tmux list-panes ${flag} -F '#{pane_id}'`);
  return raw.split("\n").filter(Boolean);
}
