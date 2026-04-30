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

export async function applyTiledLayout(windowTarget: string): Promise<void> {
  await hostExec(`tmux select-layout -t '${windowTarget}' tiled`);
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
  await hostExec(`tmux set-option -w -t '${windowTarget}' pane-border-status bottom`);
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

// ─── Shutdown Cleanup ────────────────────────────────────

export async function cleanupTeamPanes(
  leaderPane: string,
  teammatePaneIds: string[],
  opts: { hide?: boolean } = {},
): Promise<number> {
  let cleaned = 0;
  for (const pane of teammatePaneIds) {
    if (pane === leaderPane) continue;
    try {
      if (opts.hide) {
        await hostExec(`tmux break-pane -d -t '${pane}'`);
      } else {
        await hostExec(`tmux kill-pane -t '${pane}'`);
      }
      cleaned++;
    } catch { /* already gone */ }
  }
  return cleaned;
}

// ─── Unified Spawn ───────────────────────────────────────

export interface SpawnResult {
  paneId: string;
  color: AgentColor;
  isFirst: boolean;
}

export async function spawnTeammatePane(
  agentName: string,
  command: string,
  opts: { colorIndex: number; leaderPane?: string } = { colorIndex: 0 },
): Promise<SpawnResult> {
  const { withPaneLock } = await import("../../../sdk");
  const anchor = opts.leaderPane || process.env.TMUX_PANE || "";
  const targetFlag = anchor ? `-t '${anchor}' ` : "";
  const color = nextAgentColor(opts.colorIndex);

  // Wrap in zsh so the pane stays alive after the command exits
  const wrapped = `${command.replace(/'/g, "'\\''")}; exec zsh`;

  let paneId = "";
  await withPaneLock(async () => {
    paneId = (await hostExec(
      `tmux split-window ${targetFlag}-h -P -F '#{pane_id}' '${wrapped}'`,
    )).trim();
    await new Promise(r => setTimeout(r, 200));
  });

  const window = await getWindowTarget();
  const panes = await listPaneIds(window);
  const isFirst = panes.length <= 2;

  if (anchor) await rebalanceAfterSpawn(window, anchor);
  if (paneId) await stylePaneBorder(paneId, agentName, color);
  await enableBorderStatus(window);

  return { paneId, color, isFirst };
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
