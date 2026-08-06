import { loadConfig } from "../../config";

/** Resolve tmux socket path from env or config. */
export function resolveSocket(): string | undefined {
  return process.env.MAW_TMUX_SOCKET || loadConfig().tmuxSocket || undefined;
}

/** Build the `tmux` (or `tmux -S <socket>`) prefix for raw commands. */
export function tmuxCmd(): string {
  const socket = resolveSocket();
  return socket ? `tmux -S '${socket}'` : "tmux";
}

export interface TmuxPane {
  id: string;
  command: string;
  target: string;
  title: string;
  pid?: number;
  cwd?: string;
  lastActivity?: number;
  top?: number;
  left?: number;
  w?: number;
  h?: number;
  paneIdx?: number;
  winIdx?: number;
  winName?: string;
  active?: boolean;
  window?: {
    w?: number;
    h?: number;
    active?: boolean;
  };
  attached?: boolean;
  attachedClients?: number;
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
  cwd?: string;
}

export interface TmuxSession {
  name: string;
  windows: TmuxWindow[];
}

/**
 * Shell-quote a single argument for tmux commands.
 * @internal
 */
export function q(s: string | number): string {
  const str = String(s);
  // Safe chars only → no quoting needed.
  // Leading # must be escaped because some tmux builds treat # after whitespace
  // as a command-line comment, which would swallow format strings like #{pane_id}.
  if (/^[a-zA-Z0-9_.:\-\/]+$/.test(str)) return str;
  const escaped = str
    .replace(/'/g, "'\\''")
    .replace(/^#/, "\\#");
  return `'${escaped}'`;
}
