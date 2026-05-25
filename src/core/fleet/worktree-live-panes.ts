import { hostExec } from "../transport/ssh";

export interface LiveWorktreePane {
  session: string;
  windowIndex: string;
  windowName: string;
  paneIndex: string;
  target: string;
  command: string;
  cwd: string;
}

function normalizePath(value: string): string {
  return value.replace(/\s+\((?:deleted|dead)\)$/i, "").replace(/\/+$/, "");
}

export function cwdInsideWorktree(cwd: string | undefined, wtPath: string): boolean {
  if (!cwd) return false;
  const normalizedCwd = normalizePath(cwd);
  const normalizedWt = normalizePath(wtPath);
  return normalizedCwd === normalizedWt || normalizedCwd.startsWith(`${normalizedWt}/`);
}

export function parseTmuxPaneRows(raw: string): LiveWorktreePane[] {
  return raw.split("\n").filter(Boolean).flatMap(line => {
    const [session, windowIndex, windowName, paneIndex, command, cwd] = line.split("|||");
    if (!session || !windowIndex || !paneIndex) return [];
    return [{
      session,
      windowIndex,
      windowName: windowName || "",
      paneIndex,
      target: `${session}:${windowIndex}.${paneIndex}`,
      command: command || "",
      cwd: cwd || "",
    }];
  });
}

export async function listTmuxPanes(): Promise<LiveWorktreePane[]> {
  try {
    const raw = await hostExec(
      "tmux list-panes -a -F '#{session_name}|||#{window_index}|||#{window_name}|||#{pane_index}|||#{pane_current_command}|||#{pane_current_path}' 2>/dev/null || true"
    );
    return parseTmuxPaneRows(raw);
  } catch {
    return [];
  }
}

export function findPanesInWorktree(
  panes: LiveWorktreePane[],
  wtPath: string,
): LiveWorktreePane[] {
  return panes.filter(pane => cwdInsideWorktree(pane.cwd, wtPath));
}

export async function listLiveWorktreePanes(wtPath: string): Promise<LiveWorktreePane[]> {
  return findPanesInWorktree(await listTmuxPanes(), wtPath);
}
