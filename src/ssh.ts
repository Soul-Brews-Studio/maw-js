import { loadConfig } from "./config";
import { tmuxCmd } from "./tmux";

const DEFAULT_HOST = process.env.MAW_HOST || loadConfig().host || "local";
const IS_LOCAL = DEFAULT_HOST === "local" || DEFAULT_HOST === "localhost";

/** Transport — run on oracle host. local → bash -c | remote → ssh */
export async function hostExec(cmd: string, host = DEFAULT_HOST): Promise<string> {
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

/** @deprecated Use hostExec */
export const ssh = hostExec;

// Window/Session types and findWindow live in ./find-window.
// They are NOT re-exported here — callers must import them directly
// from "./find-window". This breaks the module dependency chain that
// Bun's mock.module("../src/ssh") was using to clobber findWindow
// in tests (see #198). Direct imports bypass the mock entirely.
import type { Session } from "./find-window";

export async function listSessions(host?: string): Promise<Session[]> {
  let raw: string;
  try { raw = await hostExec(`${tmuxCmd()} list-sessions -F '#{session_name}' 2>/dev/null`, host); }
  catch { return []; }
  const sessions: Session[] = [];
  for (const s of raw.split("\n").filter(Boolean)) {
    const winRaw = await hostExec(
      `${tmuxCmd()} list-windows -t '${s}' -F '#{window_index}:#{window_name}:#{window_active}' 2>/dev/null`,
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

export async function capture(target: string, lines = 80, host?: string): Promise<string> {
  // -e preserves ANSI escape sequences (colors), -S captures scroll-back
  if (lines > 50) {
    // Grab full visible pane + some scrollback
    return hostExec(`${tmuxCmd()} capture-pane -t '${target}' -e -p -S -${lines} 2>/dev/null`, host);
  }
  return hostExec(`${tmuxCmd()} capture-pane -t '${target}' -e -p 2>/dev/null | tail -${lines}`, host);
}

export async function selectWindow(target: string, host?: string): Promise<void> {
  await hostExec(`${tmuxCmd()} select-window -t '${target}' 2>/dev/null`, host);
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

/** Batch-check command + cwd for all panes. */
export async function getPaneInfos(targets: string[], host?: string): Promise<Record<string, { command: string; cwd: string }>> {
  const { Tmux } = await import("./tmux");
  const t = new Tmux(host);
  return t.getPaneInfos(targets);
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
