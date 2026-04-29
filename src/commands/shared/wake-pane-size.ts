import { tmux } from "../../sdk";

// When tmux sessions are created detached (no client attached) tmux defaults
// to 80x24. The shell inherits that, claude reads TIOCGWINSZ/$COLUMNS at
// spawn, and writes scrollback at the narrow width. Those bytes are baked
// permanently into pane history — later resizes wrap historical lines but
// do not rewrap already-written content. Symptom Boss reported 2026-04-29:
// woke-from-cron oracle panes render "mobile" (~30 cols) even after the
// tmux client attaches at 200 cols.
//
// Fix: pin window-size to manual, set explicit COLUMNS/LINES envs, and
// resize-window to a wide default BEFORE send-keys spawns claude.
export const CLAUDE_COLS = 200;
export const CLAUDE_ROWS = 50;

export async function pinSessionWide(session: string): Promise<void> {
  await tmux.setOption(session, "window-size", "manual");
  await tmux.setEnvironment(session, "COLUMNS", String(CLAUDE_COLS));
  await tmux.setEnvironment(session, "LINES", String(CLAUDE_ROWS));
  await tmux.resizeWindow(session, CLAUDE_COLS, CLAUDE_ROWS);
}

export async function pinWindowWide(target: string): Promise<void> {
  await tmux.resizeWindow(target, CLAUDE_COLS, CLAUDE_ROWS);
}
