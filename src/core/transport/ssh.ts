import { loadConfig } from "../../config";
import { tmuxCmd, Tmux } from "./tmux";

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

// Window/Session types and findWindow live in ../runtime/find-window.
// They are NOT re-exported here — callers must import them directly
// from "../runtime/find-window". This breaks the module dependency chain that
// Bun's mock.module("../src/ssh") was using to clobber findWindow
// in tests (see #198). Direct imports bypass the mock entirely.
import type { Session } from "../runtime/find-window";

type HostExecSpawn = typeof Bun.spawn;
type SshTmux = Pick<Tmux,
  | "listSessions"
  | "capture"
  | "selectWindow"
  | "getPaneCommand"
  | "getPaneCommands"
  | "getPaneInfos"
  | "exitModeIfNeeded"
  | "sendKeys"
  | "sendKeysLiteral"
  | "sendText"
>;

export interface SshDeps {
  spawn: HostExecSpawn;
  createTmux: (host?: string) => SshTmux;
  tmuxCmd: typeof tmuxCmd;
  loadConfig: typeof loadConfig;
  env: () => NodeJS.ProcessEnv;
  requireConfig: () => { loadConfig: typeof loadConfig };
}

export interface SshTransport {
  hostExec: (cmd: string, host?: string) => Promise<string>;
  ssh: (cmd: string, host?: string) => Promise<string>;
  listSessions: (host?: string) => Promise<Session[]>;
  capture: (target: string, lines?: number, host?: string) => Promise<string>;
  selectWindow: (target: string, host?: string) => Promise<void>;
  switchClient: (session: string, host?: string) => Promise<void>;
  getPaneCommand: (target: string, host?: string) => Promise<string>;
  isAgentCommand: (cmd: string | null | undefined) => boolean;
  getPaneCommands: (targets: string[], host?: string) => Promise<Record<string, string>>;
  getPaneInfos: (targets: string[], host?: string) => Promise<Record<string, { command: string; cwd: string }>>;
  sendKeys: (target: string, text: string, host?: string) => Promise<void>;
}

export function sshDeps(overrides: Partial<SshDeps> = {}): SshDeps {
  return {
    spawn: ((args, opts) => Bun.spawn(args, opts)) as HostExecSpawn,
    createTmux: (host?: string) => new Tmux(host),
    tmuxCmd,
    loadConfig,
    env: () => process.env,
    requireConfig: () => require("../../config"),
    ...overrides,
  };
}

export function createSshTransport(overrides: Partial<SshDeps> = {}): SshTransport {
  const io = sshDeps(overrides);
  const defaultHost = io.env().MAW_HOST || io.loadConfig().host || "local";
  // #713: with bind/host split, config.host is never a bind address (0.0.0.0 etc.)
  const isLocal = defaultHost === "local" || defaultHost === "localhost";

  function pathWithCommonLocalBins(env: NodeJS.ProcessEnv): string {
    const current = env.PATH ?? process.env.PATH ?? "";
    const parts = current.split(":").filter(Boolean);
    return [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      ...parts,
    ].filter((dir, index, all) => all.indexOf(dir) === index).join(":");
  }

  /** Transport — run on oracle host. local → bash -c | remote → ssh */
  async function hostExec(cmd: string, host = defaultHost): Promise<string> {
    // #713: with bind/host split, host is never a bind address (0.0.0.0 etc.)
    const local = host === "local" || host === "localhost" || isLocal;
    const transport: HostExecTransport = local ? "local" : "ssh";
    const args = local ? ["bash", "-c", cmd] : ["ssh", host, cmd];
    const env = io.env();
    const proc = io.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: local ? { ...process.env, ...env, PATH: pathWithCommonLocalBins(env) } : undefined,
    });
    const [text, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      const underlying = new Error(err.trim() || `exit ${code}`);
      throw new HostExecError(host, transport, underlying, code);
    }
    return text.trim();
  }

  const ssh = hostExec;

  async function listSessions(host?: string): Promise<Session[]> {
    const t = io.createTmux(host);
    return t.listSessions();
  }

  async function capture(target: string, lines = 80, host?: string): Promise<string> {
    const t = io.createTmux(host);
    return t.capture(target, lines);
  }

  async function selectWindow(target: string, host?: string): Promise<void> {
    const t = io.createTmux(host);
    await t.selectWindow(target);
  }

  async function switchClient(session: string, host?: string): Promise<void> {
    if (io.env().TMUX) {
      await ssh(`${io.tmuxCmd()} switch-client -t '${session}' 2>/dev/null`, host).catch(() => {});
    }
  }

  /** Get the command running in a tmux pane (e.g. "claude", "zsh") */
  async function getPaneCommand(target: string, host?: string): Promise<string> {
    const t = io.createTmux(host);
    return t.getPaneCommand(target);
  }

/** Pane command looks like an AI agent — name match (claude/codex/node),
 *  Claude Code 2.1+ versioned-binary signature (e.g. "2.1.121"), or any
 *  binary from config.commands entries.
 *
 *  #10: `cmd` is a tmux `#{pane_current_command}` — a bare command basename,
 *  not a command line. `claude` / `codex` are distinctive enough that a
 *  substring match is safe (no benign command contains them), but `node` is
 *  a substring of `nodemon`, the `node` REPL, `node-red`, and any number of
 *  non-agent tools. So `node` (and configured binaries) are matched as the
 *  WHOLE command name — not loose substrings — so non-agent node processes
 *  don't pass. */
  function isAgentCommand(cmd: string | null | undefined): boolean {
    const c = (cmd ?? "").trim();
    if (!c) return false;
    if (/claude|codex/i.test(c)) return true;
    if (/^node$/i.test(c)) return true;
    if (/^\d+\.\d+\.\d+$/.test(c)) return true;
    try {
      const { loadConfig } = io.requireConfig();
      const commands: Record<string, string> = loadConfig().commands || {};
      const lc = c.toLowerCase();
      for (const v of Object.values(commands)) {
        const bin = v.split(/\s/)[0];
        // Exact name match, not substring — a configured `node`-launched agent
        // must not make every `nodemon`/`node-*` pane look like an agent.
        if (bin && bin !== "default" && lc === bin.toLowerCase()) return true;
      }
    } catch {}
    return false;
  }

/** Batch-check which panes are running what command. */
  async function getPaneCommands(targets: string[], host?: string): Promise<Record<string, string>> {
    const t = io.createTmux(host);
    return t.getPaneCommands(targets);
  }

/** Batch-check command + cwd for all panes. */
  async function getPaneInfos(targets: string[], host?: string): Promise<Record<string, { command: string; cwd: string }>> {
    const t = io.createTmux(host);
    return t.getPaneInfos(targets);
  }

  async function sendKeys(target: string, text: string, host?: string): Promise<void> {
    const t = io.createTmux(host);

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
      if (text !== "\x1b") await t.exitModeIfNeeded(target);
      await t.sendKeys(target, SPECIAL_KEYS[text]);
      return;
    }

    // Strip trailing \r or \n — Enter is appended separately
    const endsWithEnter = text.endsWith("\r") || text.endsWith("\n");
    const body = endsWithEnter ? text.slice(0, -1) : text;

    // If only the enter was left after stripping, just send Enter
    if (!body) {
      await t.exitModeIfNeeded(target);
      await t.sendKeys(target, "Enter");
      return;
    }

    if (body.startsWith("/")) {
      // Slash commands: send char by char for interactive tools (Claude Code, etc.)
      await t.exitModeIfNeeded(target);
      for (const ch of body) {
        await t.sendKeysLiteral(target, ch);
      }
      await t.sendKeys(target, "Enter");
    } else {
      // Smart send — uses buffer for multiline/long, send-keys for short
      await t.sendText(target, body);
    }
  }

  return {
    hostExec,
    ssh,
    listSessions,
    capture,
    selectWindow,
    switchClient,
    getPaneCommand,
    isAgentCommand,
    getPaneCommands,
    getPaneInfos,
    sendKeys,
  };
}

const defaultSshTransport = createSshTransport();

export const hostExec = defaultSshTransport.hostExec;
/** @deprecated Use hostExec */
export const ssh = defaultSshTransport.ssh;
export const listSessions = defaultSshTransport.listSessions;
export const capture = defaultSshTransport.capture;
export const selectWindow = defaultSshTransport.selectWindow;
export const switchClient = defaultSshTransport.switchClient;
export const getPaneCommand = defaultSshTransport.getPaneCommand;
export const isAgentCommand = defaultSshTransport.isAgentCommand;
export const getPaneCommands = defaultSshTransport.getPaneCommands;
export const getPaneInfos = defaultSshTransport.getPaneInfos;
export const sendKeys = defaultSshTransport.sendKeys;
