import { listSessions, ssh } from "./ssh";
import type { Session } from "./ssh";

export interface OverviewTarget {
  session: string;
  window: number;
  windowName: string;
  oracle: string;
}

export const PANES_PER_PAGE = 9;

export function buildTargets(sessions: Session[], filters: string[]): OverviewTarget[] {
  let targets = sessions
    .filter(s => /^\d+-/.test(s.name) && s.name !== "0-overview")
    .map(s => {
      const active = s.windows.find(w => w.active) || s.windows[0];
      const oracleName = s.name.replace(/^\d+-/, "");
      return { session: s.name, window: active?.index ?? 1, windowName: active?.name ?? oracleName, oracle: oracleName };
    });

  if (filters.length) {
    targets = targets.filter(t => filters.some(f => t.oracle.includes(f) || t.session.includes(f)));
  }

  return targets;
}

const PANE_COLORS = [
  "colour204",  // pink
  "colour114",  // green
  "colour81",   // blue
  "colour220",  // yellow
  "colour177",  // purple
  "colour208",  // orange
  "colour44",   // cyan
  "colour196",  // red
  "colour83",   // lime
  "colour141",  // lavender
];

export function paneColor(index: number): string {
  return PANE_COLORS[index % PANE_COLORS.length];
}

export function paneTitle(t: OverviewTarget): string {
  return `${t.oracle} (${t.session}:${t.window})`;
}

export function processMirror(raw: string, lines: number): string {
  const sep = '─'.repeat(60);
  const filtered = raw
    .replace(/[─━]{6,}/g, sep)
    .split('\n')
    .filter(l => l.trim() !== '');
  const visible = filtered.slice(-lines);
  const pad = Math.max(0, lines - visible.length);
  return '\n'.repeat(pad) + visible.join('\n');
}

export function mirrorCmd(t: OverviewTarget): string {
  const target = encodeURIComponent(`${t.session}:${t.window}`);
  const port = process.env.MAW_PORT || "3456";
  return `watch --color -t -n0.5 'curl -s "http://localhost:${port}/api/mirror?target=${target}&lines=\\$(tput lines)"'`;
}

export function pickLayout(count: number): string {
  if (count <= 2) return "even-horizontal";
  return "tiled";  // 2×2 grid
}

export function chunkTargets(targets: OverviewTarget[]): OverviewTarget[][] {
  const pages: OverviewTarget[][] = [];
  for (let i = 0; i < targets.length; i += PANES_PER_PAGE) {
    pages.push(targets.slice(i, i + PANES_PER_PAGE));
  }
  return pages;
}

export async function cmdOverview(filterArgs: string[]) {
  const kill = filterArgs.includes("--kill") || filterArgs.includes("-k");
  const filters = filterArgs.filter(a => !a.startsWith("-"));

  // Kill existing overview
  try { await ssh("tmux kill-session -t 0-overview 2>/dev/null"); } catch {}
  if (kill) { console.log("overview killed"); return; }

  // Gather oracle targets
  const sessions = await listSessions();
  const targets = buildTargets(sessions, filters);

  if (!targets.length) { console.error("no oracle sessions found"); return; }

  const pages = chunkTargets(targets);

  // Create overview session with first window
  await ssh("tmux new-session -d -s 0-overview -n page-1");

  // Style: pane borders
  await ssh("tmux set -t 0-overview pane-border-status top");
  await ssh('tmux set -t 0-overview pane-border-format " #{pane_title} "');
  await ssh("tmux set -t 0-overview pane-border-style fg=colour238");
  await ssh("tmux set -t 0-overview pane-active-border-style fg=colour45");

  // Style: status bar
  await ssh("tmux set -t 0-overview status-style bg=colour235,fg=colour248");
  await ssh("tmux set -t 0-overview status-left-length 40");
  await ssh("tmux set -t 0-overview status-right-length 60");
  await ssh(`tmux set -t 0-overview status-left '#[fg=colour16,bg=colour204,bold] \u2588 MAW #[fg=colour204,bg=colour238] #[fg=colour255,bg=colour238] ${targets.length} oracles #[fg=colour238,bg=colour235] '`);
  await ssh(`tmux set -t 0-overview status-right '#[fg=colour238,bg=colour235]#[fg=colour114,bg=colour238] \u25cf live #[fg=colour81,bg=colour238] %H:%M #[fg=colour16,bg=colour81,bold] %d-%b '`);
  await ssh("tmux set -t 0-overview status-justify centre");
  await ssh("tmux set -t 0-overview window-status-format '#[fg=colour248,bg=colour235] #I:#W '");
  await ssh("tmux set -t 0-overview window-status-current-format '#[fg=colour16,bg=colour45,bold] #I:#W '");

  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const winName = `page-${p + 1}`;

    // First page uses the already-created window
    if (p > 0) {
      await ssh(`tmux new-window -t 0-overview -n ${winName}`);
    }

    // First pane — set colored title and start mirror
    const baseIdx = p * PANES_PER_PAGE;
    const pane0 = `0-overview:${winName}.0`;
    const color0 = paneColor(baseIdx);
    await ssh(`tmux select-pane -t ${pane0} -T '#[fg=${color0},bold]${paneTitle(page[0])}#[default]'`);
    await ssh(`tmux send-keys -t ${pane0} "${mirrorCmd(page[0]).replace(/"/g, '\\"')}" Enter`);

    // Split for remaining targets in this page
    for (let i = 1; i < page.length; i++) {
      await ssh(`tmux split-window -t 0-overview:${winName}`);
      const paneId = `0-overview:${winName}.${i}`;
      const color = paneColor(baseIdx + i);
      await ssh(`tmux select-pane -t ${paneId} -T '#[fg=${color},bold]${paneTitle(page[i])}#[default]'`);
      await ssh(`tmux send-keys -t ${paneId} "${mirrorCmd(page[i]).replace(/"/g, '\\"')}" Enter`);
      await ssh(`tmux select-layout -t 0-overview:${winName} tiled`);
    }

    // Final layout for this page
    const layout = pickLayout(page.length);
    await ssh(`tmux select-layout -t 0-overview:${winName} ${layout}`);
  }

  // Go back to first window
  await ssh("tmux select-window -t 0-overview:page-1");

  console.log(`\x1b[32m✅\x1b[0m overview: ${targets.length} oracles across ${pages.length} page${pages.length > 1 ? 's' : ''}`);
  for (let p = 0; p < pages.length; p++) {
    console.log(`  page-${p + 1}: ${pages[p].map(t => t.oracle).join(', ')}`);
  }
  console.log(`\n  attach: tmux attach -t 0-overview`);
  if (pages.length > 1) console.log(`  navigate: Ctrl-b n/p (next/prev page)`);
}
