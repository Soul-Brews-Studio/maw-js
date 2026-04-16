import { listSessions, hostExec } from "../../../sdk";
import { tmux } from "../../../sdk";
import { loadConfig } from "../../../config";
import type { Session } from "../../../sdk";

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
  const port = loadConfig().port;
  return `watch --color -t -n0.5 'curl -s "http://localhost:${port}/api/mirror?target=${target}&lines=$(tput lines)"'`;
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
  await tmux.killSession("0-overview");
  if (kill) { console.log("overview killed"); return; }

  // Gather oracle targets
  const sessions = await listSessions();
  const targets = buildTargets(sessions, filters);

  if (!targets.length) { console.error("no oracle sessions found"); return; }

  const pages = chunkTargets(targets);

  // Create overview session with first window
  await tmux.newSession("0-overview", { window: "page-1" });

  // Style: pane borders
  await tmux.set("0-overview", "pane-border-status", "top");
  await tmux.set("0-overview", "pane-border-format", " #{pane_title} ");
  await tmux.set("0-overview", "pane-border-style", "fg=colour238");
  await tmux.set("0-overview", "pane-active-border-style", "fg=colour45");

  // Style: status bar
  await tmux.set("0-overview", "status-style", "bg=colour235,fg=colour248");
  await tmux.set("0-overview", "status-left-length", "40");
  await tmux.set("0-overview", "status-right-length", "60");
  await tmux.set("0-overview", "status-left", `#[fg=colour16,bg=colour204,bold] \u2588 MAW #[fg=colour204,bg=colour238] #[fg=colour255,bg=colour238] ${targets.length} oracles #[fg=colour238,bg=colour235] `);
  await tmux.set("0-overview", "status-right", `#[fg=colour238,bg=colour235]#[fg=colour114,bg=colour238] \u25cf live #[fg=colour81,bg=colour238] %H:%M #[fg=colour16,bg=colour81,bold] %d-%b `);
  await tmux.set("0-overview", "status-justify", "centre");
  await tmux.set("0-overview", "window-status-format", "#[fg=colour248,bg=colour235] #I:#W ");
  await tmux.set("0-overview", "window-status-current-format", "#[fg=colour16,bg=colour45,bold] #I:#W ");

  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const winName = `page-${p + 1}`;

    // First page uses the already-created window
    if (p > 0) {
      await tmux.newWindow("0-overview", winName);
    }

    // First pane — set colored title and start mirror
    const baseIdx = p * PANES_PER_PAGE;
    const pane0 = `0-overview:${winName}.0`;
    const color0 = paneColor(baseIdx);
    await tmux.selectPane(pane0, { title: `#[fg=${color0},bold]${paneTitle(page[0])}#[default]` });
    await tmux.sendKeys(pane0, mirrorCmd(page[0]), "Enter");

    // Split for remaining targets in this page
    for (let i = 1; i < page.length; i++) {
      await tmux.splitWindow(`0-overview:${winName}`);
      const paneId = `0-overview:${winName}.${i}`;
      const color = paneColor(baseIdx + i);
      await tmux.selectPane(paneId, { title: `#[fg=${color},bold]${paneTitle(page[i])}#[default]` });
      await tmux.sendKeys(paneId, mirrorCmd(page[i]), "Enter");
      await tmux.selectLayout(`0-overview:${winName}`, "tiled");
    }

    // Final layout for this page
    const layout = pickLayout(page.length);
    await tmux.selectLayout(`0-overview:${winName}`, layout);
  }

  // Go back to first window
  await tmux.selectWindow("0-overview:page-1");

  console.log(`\x1b[32m✅\x1b[0m overview: ${targets.length} oracles across ${pages.length} page${pages.length > 1 ? 's' : ''}`);
  for (let p = 0; p < pages.length; p++) {
    console.log(`  page-${p + 1}: ${pages[p].map(t => t.oracle).join(', ')}`);
  }
  console.log(`\n  attach: tmux attach -t 0-overview`);
  if (pages.length > 1) console.log(`  navigate: Ctrl-b n/p (next/prev page)`);
}
