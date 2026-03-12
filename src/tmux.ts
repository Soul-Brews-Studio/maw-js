import { ssh } from "./ssh";

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
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

  /** Create a grouped session — shares windows with parent, independent sizing. Auto-destroys on detach. */
  async newGroupedSession(parent: string, name: string, opts: {
    cols: number;
    rows: number;
    window?: string;
  }): Promise<void> {
    await this.run("new-session", "-d", "-t", parent, "-s", name, "-x", opts.cols, "-y", opts.rows);
    await this.setOption(name, "destroy-unattached", "on");
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
