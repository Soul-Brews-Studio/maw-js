import { loadConfig } from "./config";

const DEFAULT_HOST = process.env.MAW_HOST || loadConfig().host || "white.local";
const IS_LOCAL = DEFAULT_HOST === "local" || DEFAULT_HOST === "localhost";

export async function ssh(cmd: string, host = DEFAULT_HOST): Promise<string> {
  const local = host === "local" || host === "localhost" || IS_LOCAL;
  const args = local ? ["bash", "-c", cmd] : ["ssh", host, cmd];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(err.trim() || `exit ${code}`);
  }
  return text.trim();
}

export interface Window {
  index: number;
  name: string;
  active: boolean;
}

export interface Session {
  name: string;
  windows: Window[];
}

export async function listSessions(host?: string): Promise<Session[]> {
  let raw: string;
  try { raw = await ssh("tmux list-sessions -F '#{session_name}' 2>/dev/null", host); }
  catch { return []; }
  const sessions: Session[] = [];
  for (const s of raw.split("\n").filter(Boolean)) {
    const winRaw = await ssh(
      `tmux list-windows -t '${s}' -F '#{window_index}:#{window_name}:#{window_active}' 2>/dev/null`,
      host,
    );
    const windows = winRaw.split("\n").filter(Boolean).map(w => {
      const [idx, name, active] = w.split(":");
      return { index: +idx, name, active: active === "1" };
    });
    sessions.push({ name: s, windows });
  }
  return sessions;
}

export function findWindow(sessions: Session[], query: string): string | null {
  const q = query.toLowerCase();
  for (const s of sessions) {
    for (const w of s.windows) {
      if (w.name.toLowerCase().includes(q)) return `${s.name}:${w.index}`;
    }
  }
  if (query.includes(":")) return query;
  return null;
}

export async function capture(target: string, lines = 80, host?: string): Promise<string> {
  // -e preserves ANSI escape sequences (colors), -S captures scroll-back
  if (lines > 50) {
    // Grab full visible pane + some scrollback
    return ssh(`tmux capture-pane -t '${target}' -e -p -S -${lines} 2>/dev/null`, host);
  }
  return ssh(`tmux capture-pane -t '${target}' -e -p 2>/dev/null | tail -${lines}`, host);
}

export async function selectWindow(target: string, host?: string): Promise<void> {
  await ssh(`tmux select-window -t '${target}' 2>/dev/null`, host);
}

/** Get the command running in a tmux pane (e.g. "claude", "zsh") */
export async function getPaneCommand(target: string, host?: string): Promise<string> {
  const { Tmux } = await import("./tmux");
  const t = new Tmux(host);
  return t.getPaneCommand(target);
}

/** Batch-check which panes are running what command. */
export async function getPaneCommands(targets: string[], host?: string): Promise<Record<string, string>> {
  const { Tmux } = await import("./tmux");
  const t = new Tmux(host);
  return t.getPaneCommands(targets);
}

export async function sendKeys(target: string, text: string, host?: string): Promise<void> {
  const { Tmux } = await import("./tmux");
  const t = new Tmux(host);

  // Special keys → send as tmux key names (no Enter appended)
  const SPECIAL_KEYS: Record<string, string> = {
    "\x1b": "Escape",
    "\x1b[A": "Up",
    "\x1b[B": "Down",
    "\x1b[C": "Right",
    "\x1b[D": "Left",
    "\r": "Enter",
    "\n": "Enter",
    "\b": "BSpace",
    "\x15": "C-u",
  };
  if (SPECIAL_KEYS[text]) {
    await t.sendKeys(target, SPECIAL_KEYS[text]);
    return;
  }

  // Strip trailing \r or \n — Enter is appended separately
  const endsWithEnter = text.endsWith("\r") || text.endsWith("\n");
  const body = endsWithEnter ? text.slice(0, -1) : text;

  // If only the enter was left after stripping, just send Enter
  if (!body) {
    await t.sendKeys(target, "Enter");
    return;
  }

  if (body.startsWith("/")) {
    // Slash commands: send char by char for interactive tools (Claude Code, etc.)
    for (const ch of body) {
      await t.sendKeysLiteral(target, ch);
    }
    await t.sendKeys(target, "Enter");
  } else {
    // Smart send — uses buffer for multiline/long, send-keys for short
    await t.sendText(target, body);
  }
}
