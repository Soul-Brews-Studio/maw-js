import { loadConfig } from "../../config";
import { tmuxCmd, Tmux } from "./tmux";

const DEFAULT_HOST = process.env.MAW_HOST || loadConfig().host || "local";
const IS_LOCAL = DEFAULT_HOST === "local" || DEFAULT_HOST === "localhost";

export type HostExecTransport = "local" | "ssh";

/** Error from hostExec — carries target + transport so callers can format. */
export class HostExecError extends Error {
  readonly target: string;
  readonly transport: HostExecTransport;
  readonly underlying: Error;
  readonly exitCode?: number;

  constructor(target: string, transport: HostExecTransport, underlying: Error, exitCode?: number) {
    super(`[${transport}:${target}] ${underlying.message}`);
    this.name = "HostExecError";
    this.target = target;
    this.transport = transport;
    this.underlying = underlying;
    this.exitCode = exitCode;
  }
}

/** Transport — run on oracle host. local → bash -c | remote → ssh */
export async function hostExec(cmd: string, host = DEFAULT_HOST): Promise<string> {
  const local = host === "local" || host === "localhost" || IS_LOCAL;
  const transport: HostExecTransport = local ? "local" : "ssh";
  const args = local ? ["bash", "-c", cmd] : ["ssh", host, cmd];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    const underlying = new Error(err.trim() || `exit ${code}`);
    throw new HostExecError(host, transport, underlying, code);
  }
  return text.trim();
}

/** @deprecated Use hostExec */
export const ssh = hostExec;

// Window/Session types and findWindow live in ../runtime/find-window.
// They are NOT re-exported here — callers must import them directly
// from "../runtime/find-window". This breaks the module dependency chain that
// Bun's mock.module("../src/ssh") was using to clobber findWindow
// in tests (see #198). Direct imports bypass the mock entirely.
import type { Session } from "../runtime/find-window";

export async function listSessions(host?: string): Promise<Session[]> {
  const t = new Tmux(host);
  return t.listSessions();
}

export async function capture(target: string, lines = 80, host?: string): Promise<string> {
  const t = new Tmux(host);
  return t.capture(target, lines);
}

export async function selectWindow(target: string, host?: string): Promise<void> {
  const t = new Tmux(host);
  await t.selectWindow(target);
}

export async function switchClient(session: string, host?: string): Promise<void> {
  if (process.env.TMUX) {
    await ssh(`${tmuxCmd()} switch-client -t '${session}' 2>/dev/null`, host).catch(() => {});
  }
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
