import { ssh } from "./ssh";

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

/** Shell-quote a single argument for tmux commands. */
function q(s: string | number): string {
  const str = String(s);
  // Safe chars only → no quoting needed
  if (/^[a-zA-Z0-9_.:\-\/]+$/.test(str)) return str;
  // Wrap in single quotes, escape inner single quotes
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/**
 * Typed wrapper around tmux CLI.
 * All methods build arg arrays and delegate to `run()`.
 */
export class Tmux {
  constructor(private host?: string) {}

  /** Base runner — executes `tmux <subcommand> [args...]` via ssh. */
  async run(subcommand: string, ...args: (string | number)[]): Promise<string> {
    const cmd = `tmux ${subcommand} ${args.map(q).join(" ")} 2>/dev/null`;
    return ssh(cmd, this.host);
  }

  /** Like run() but swallows errors — for best-effort cleanup ops. */
  async tryRun(subcommand: string, ...args: (string | number)[]): Promise<string> {
    return this.run(subcommand, ...args).catch(() => "");
  }

  // --- Sessions ---

  async listSessions(): Promise<TmuxSession[]> {
    const raw = await this.run("list-sessions", "-F", "#{session_name}");
    const sessions: TmuxSession[] = [];
    for (const s of raw.split("\n").filter(Boolean)) {
      const windows = await this.listWindows(s);
      sessions.push({ name: s, windows });
    }
    return sessions;
  }

  /** List all windows across all sessions in a single tmux call. */
  async listAll(): Promise<TmuxSession[]> {
    const raw = await this.run("list-windows", "-a", "-F", "#{session_name}|||#{window_index}|||#{window_name}|||#{window_active}|||#{pane_current_path}");
    const map = new Map<string, TmuxWindow[]>();
    for (const line of raw.split("\n").filter(Boolean)) {
      const [session, idx, name, active, cwd] = line.split("|||");
      if (!map.has(session)) map.set(session, []);
      map.get(session)!.push({ index: +idx, name, active: active === "1", cwd: cwd || undefined });
    }
    return [...map.entries()].map(([name, windows]) => ({ name, windows }));
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.run("has-session", "-t", name);
      return true;
    } catch {
      return false;
    }
  }

  async newSession(name: string, opts: {
    window?: string;
    cwd?: string;
    detached?: boolean;
  } = {}): Promise<void> {
    const args: (string | number)[] = [];
    if (opts.detached !== false) args.push("-d");
    args.push("-s", name);
    if (opts.window) args.push("-n", opts.window);
    if (opts.cwd) args.push("-c", opts.cwd);
    await this.run("new-session", ...args);
  }

  /** Create a grouped session — shares windows with parent, independent sizing.
   *  Caller is responsible for cleanup via killSession(). */
  async newGroupedSession(parent: string, name: string, opts: {
    cols: number;
    rows: number;
    window?: string;
  }): Promise<void> {
    await this.run("new-session", "-d", "-t", parent, "-s", name, "-x", opts.cols, "-y", opts.rows);
    // Note: do NOT set destroy-unattached here — tmux kills the session
    // immediately since it was created detached (-d) with no client yet.
    if (opts.window) await this.selectWindow(`${name}:${opts.window}`);
  }

  async killSession(name: string): Promise<void> {
    await this.tryRun("kill-session", "-t", name);
  }

  // --- Windows ---

  async listWindows(session: string): Promise<TmuxWindow[]> {
    const raw = await this.run("list-windows", "-t", session, "-F", "#{window_index}:#{window_name}:#{window_active}");
    return raw.split("\n").filter(Boolean).map(w => {
      const [idx, name, active] = w.split(":");
      return { index: +idx, name, active: active === "1" };
    });
  }

  async newWindow(session: string, name: string, opts: { cwd?: string } = {}): Promise<void> {
    const args: (string | number)[] = ["-t", session, "-n", name];
    if (opts.cwd) args.push("-c", opts.cwd);
    await this.run("new-window", ...args);
  }

  async selectWindow(target: string): Promise<void> {
    await this.tryRun("select-window", "-t", target);
  }

  async killWindow(target: string): Promise<void> {
    await this.tryRun("kill-window", "-t", target);
  }

  // --- Panes ---

  /** Get the command running in a pane (e.g. "claude", "zsh") */
  async getPaneCommand(target: string): Promise<string> {
    const raw = await this.run("list-panes", "-t", target, "-F", "#{pane_current_command}");
    return raw.split("\n")[0] || "";
  }

  /** Batch-check which panes are running what command. */
  async getPaneCommands(targets: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    await Promise.allSettled(targets.map(async (t) => {
      try { result[t] = await this.getPaneCommand(t); } catch {}
    }));
    return result;
  }

  /** Get command + cwd for a pane. */
  async getPaneInfo(target: string): Promise<{ command: string; cwd: string }> {
    const raw = await this.run("list-panes", "-t", target, "-F", "#{pane_current_command}\t#{pane_current_path}");
    const [command = "", cwd = ""] = raw.split("\n")[0].split("\t");
    return { command, cwd };
  }

  /** Batch-check command + cwd for all panes. */
  async getPaneInfos(targets: string[]): Promise<Record<string, { command: string; cwd: string }>> {
    const result: Record<string, { command: string; cwd: string }> = {};
    await Promise.allSettled(targets.map(async (t) => {
      try { result[t] = await this.getPaneInfo(t); } catch {}
    }));
    return result;
  }

  async capture(target: string, lines = 80): Promise<string> {
    if (lines > 50) {
      return this.run("capture-pane", "-t", target, "-e", "-p", "-S", -lines);
    }
    // For shorter captures, pipe through tail (needs raw ssh)
    const cmd = `tmux capture-pane -t ${q(target)} -e -p 2>/dev/null | tail -${lines}`;
    return ssh(cmd, this.host);
  }

  async resizePane(target: string, cols: number, rows: number): Promise<void> {
    const c = Math.max(1, Math.min(500, Math.floor(cols)));
    const r = Math.max(1, Math.min(200, Math.floor(rows)));
    await this.tryRun("resize-pane", "-t", target, "-x", c, "-y", r);
  }

  async splitWindow(target: string): Promise<void> {
    await this.run("split-window", "-t", target);
  }

  async selectPane(target: string, opts: { title?: string } = {}): Promise<void> {
    const args: (string | number)[] = ["-t", target];
    if (opts.title) args.push("-T", opts.title);
    await this.run("select-pane", ...args);
  }

  async selectLayout(target: string, layout: string): Promise<void> {
    await this.run("select-layout", "-t", target, layout);
  }

  // --- Keys ---

  async sendKeys(target: string, ...keys: string[]): Promise<void> {
    await this.run("send-keys", "-t", target, ...keys);
  }

  async sendKeysLiteral(target: string, text: string): Promise<void> {
    await this.run("send-keys", "-t", target, "-l", text);
  }

  // --- Buffers ---

  async loadBuffer(text: string): Promise<void> {
    const escaped = text.replace(/'/g, "'\\''");
    const cmd = `printf '%s' '${escaped}' | tmux load-buffer -`;
    await ssh(cmd, this.host);
  }

  async pasteBuffer(target: string): Promise<void> {
    await this.run("paste-buffer", "-t", target);
  }

  /**
   * Smart text sending — uses load-buffer for multiline/long messages,
   * send-keys for short single-line. Always appends Enter.
   * Ported from old bash maw hey (Dec 2025).
   */
  async sendText(target: string, text: string): Promise<void> {
    if (text.includes("\n") || text.length > 500) {
      // Buffer method — reliable for multiline/long content
      await this.loadBuffer(text);
      await this.pasteBuffer(target);
      // Claude Code needs time to process paste event before Enter (#16)
      await new Promise(r => setTimeout(r, 150));
      await this.sendKeys(target, "Enter");
    } else {
      // Literal send — -l prevents tmux from interpreting special chars like |
      await this.sendKeysLiteral(target, text);
      await this.sendKeys(target, "Enter");
    }
  }

  // --- Environment ---

  async setEnvironment(session: string, key: string, value: string): Promise<void> {
    await this.run("set-environment", "-t", session, key, value);
  }

  // --- Options ---

  async setOption(target: string, option: string, value: string): Promise<void> {
    await this.tryRun("set-option", "-t", target, option, value);
  }

  async set(target: string, option: string, value: string): Promise<void> {
    await this.tryRun("set", "-t", target, option, value);
  }
}

/** Default tmux instance (uses default host from ssh config). */
export const tmux = new Tmux();
