import { hostExec } from "./ssh";
import { cfgLimit } from "../../config";
import {
  q,
  resolveSocket,
  type TmuxPane,
  type TmuxSession,
  type TmuxWindow,
} from "./tmux-types";

// --- sendText submit-confirmation tuning (#6) ---
// The old sendText fired 3 blind `Enter` keys on a fixed ~1.9s schedule with
// zero feedback. If the pane wasn't ready when they landed (agent still
// rendering the paste, brief stall), every Enter missed and the command sat
// in the input box unexecuted — this forced manual re-launch of dispatches
// on 2026-05-14. We now send Enter, re-check the pane, and retry only while
// input is still pending.
/** Wait after paste/literal-send before the first Enter — lets the input settle. */
const SEND_SETTLE_MS = 1500;
/** Wait after each Enter before re-checking whether the input line cleared. */
const SUBMIT_CONFIRM_MS = 700;
/** Max Enter attempts before giving up and warning (was 3 blind, unconditional sends). */
const MAX_SUBMIT_ATTEMPTS = 4;
/** ANSI escape stripper — matches checkPaneIdle in comm-send.ts (#405). */
const ANSI_RE = /\x1b\[[0-9;]*[mGKHFJA-Z]/g;

function pendingInputNeedles(sentText: string): string[] {
  const normalized = sentText.replace(/\r/g, "").trim();
  if (!normalized) return [];

  const needles = new Set<string>();
  const compact = normalized.replace(/\s+/g, " ").trim();
  if (compact) needles.add(compact.slice(0, 40));

  const lastLine = normalized
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .at(-1);
  if (lastLine) needles.add(lastLine.slice(0, 40));

  return [...needles].filter(Boolean);
}

function isTmuxNoServerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no server/i.test(message) || /failed to connect to server/i.test(message);
}

function isTmuxBinaryMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const exitCode = typeof error === "object" && error !== null && "exitCode" in error
    ? (error as { exitCode?: unknown }).exitCode
    : undefined;
  return exitCode === 127 || /tmux: command not found/i.test(message) || /command not found: tmux/i.test(message);
}

/**
 * Typed wrapper around tmux CLI.
 * All methods build arg arrays and delegate to `run()`.
 */
export class Tmux {
  private socket?: string;
  constructor(private host?: string, socket?: string) {
    this.socket = socket !== undefined ? socket : resolveSocket();
  }

  /** Base runner — executes `tmux [-S socket] <subcommand> [args...]` via hostExec. */
  async run(subcommand: string, ...args: (string | number)[]): Promise<string> {
    const socketFlag = this.socket ? `-S ${q(this.socket)} ` : "";
    const needsTermFallback = !process.env.TERM && process.env.MAW_TEST_MODE !== "1";
    const termPrefix = needsTermFallback ? "TERM=xterm " : "";
    const cmd = `${termPrefix}tmux ${socketFlag}${subcommand} ${args.map(q).join(" ")}`;
    return hostExec(cmd, this.host);
  }

  /** Like run() but swallows errors — for best-effort cleanup ops. */
  async tryRun(subcommand: string, ...args: (string | number)[]): Promise<string> {
    return this.run(subcommand, ...args).catch(() => "");
  }

  // --- Sessions ---

  async listSessions(): Promise<TmuxSession[]> {
    try {
      const raw = await this.run("list-sessions", "-F", "#{session_name}");
      const sessions: TmuxSession[] = [];
      for (const s of raw.split("\n").filter(Boolean)) {
        const windows = await this.listWindows(s);
        sessions.push({ name: s, windows });
      }
      return sessions;
    } catch (error) {
      if (isTmuxBinaryMissingError(error)) throw error;
      if (isTmuxNoServerError(error)) return [];
      return [];
    }
  }

  /** List all windows across all sessions in a single tmux call. */
  async listAll(): Promise<TmuxSession[]> {
    try {
      const raw = await this.run("list-windows", "-a", "-F", "#{session_name}|||#{window_index}|||#{window_name}|||#{window_active}|||#{pane_current_path}");
      const map = new Map<string, TmuxWindow[]>();
      for (const line of raw.split("\n").filter(Boolean)) {
        const [session, idx, name, active, cwd] = line.split("|||");
        if (!map.has(session)) map.set(session, []);
        map.get(session)!.push({ index: +idx, name, active: active === "1", cwd: cwd || undefined });
      }
      return [...map.entries()].map(([name, windows]) => ({ name, windows }));
    } catch (error) {
      if (isTmuxBinaryMissingError(error)) throw error;
      if (isTmuxNoServerError(error)) return [];
      return [];
    }
  }

  /**
   * List every session with its group name in a single tmux call.
   * `#{session_group}` is empty for ungrouped sessions and equals the parent
   * session name for grouped ones (verified on live tmux: a maw-pty-* grouped
   * to `01-labubu` reports group `01-labubu`). Used by the orphan-PTY reaper
   * (#P2 sweep) and attach-time grouped-orphan kill (#P3).
   */
  async listSessionGroups(): Promise<Array<{ name: string; group: string }>> {
    try {
      const raw = await this.run("list-sessions", "-F", "#{session_name}|||#{session_group}");
      return raw.split("\n").filter(Boolean).map(line => {
        const [name, group = ""] = line.split("|||");
        return { name, group };
      });
    } catch (error) {
      if (isTmuxBinaryMissingError(error)) throw error;
      if (isTmuxNoServerError(error)) return [];
      return [];
    }
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
    command?: string;
    printFormat?: string;
  } = {}): Promise<string> {
    const args: (string | number)[] = [];
    if (opts.detached !== false) args.push("-d");
    if (opts.printFormat) args.push("-P", "-F", opts.printFormat);
    args.push("-s", name);
    if (opts.window) args.push("-n", opts.window);
    if (opts.cwd) args.push("-c", opts.cwd);
    if (opts.command) args.push(opts.command);
    const out = await this.run("new-session", ...args);
    await this.setOption(name, "renumber-windows", "on");
    return out;
  }

  async firstPaneId(target: string): Promise<string | undefined> {
    try {
      const raw = await this.run("list-panes", "-t", target, "-F", "#{pane_id}");
      return raw.split("\n").map(line => line.trim()).find(Boolean);
    } catch {
      return undefined;
    }
  }

  /** Create a grouped session — shares windows with parent, independent sizing.
   *  Caller is responsible for cleanup via killSession(). */
  async newGroupedSession(parent: string, name: string, opts: {
    cols?: number;
    rows?: number;
    window?: string;
    windowSize?: "largest" | "smallest" | "latest" | "manual";
  } = {}): Promise<void> {
    const args: (string | number)[] = ["-d", "-t", parent, "-s", name];
    if (opts.cols !== undefined) args.push("-x", opts.cols);
    if (opts.rows !== undefined) args.push("-y", opts.rows);
    await this.run("new-session", ...args);
    // Note: do NOT set destroy-unattached here — tmux kills the session
    // immediately since it was created detached (-d) with no client yet.
    if (opts.windowSize) await this.setOption(name, "window-size", opts.windowSize);
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
    // Trailing colon on -t forces "next free index" semantics.
    // Without it, `-t session` is interpreted as `-t session:<current_window>`,
    // and tmux tries to create AT that index → "index 1 in use" error.
    const args: (string | number)[] = ["-t", `${session}:`, "-n", name];
    if (opts.cwd) args.push("-c", opts.cwd);
    await this.run("new-window", ...args);
  }

  async selectWindow(target: string): Promise<void> {
    await this.tryRun("select-window", "-t", target);
  }

  /** Switch the current tmux client to a different session. Only works when inside tmux. */
  async switchClient(session: string, opts: { readonly?: boolean } = {}): Promise<void> {
    if (!opts.readonly) {
      await this.tryRun("switch-client", "-t", session);
      return;
    }

    const readonly = await this.tryRun("display-message", "-p", "#{client_readonly}");
    const args: (string | number)[] = readonly.trim() === "1"
      ? ["-t", session]
      : ["-r", "-t", session];
    await this.tryRun("switch-client", ...args);
  }

  async killWindow(target: string): Promise<void> {
    await this.tryRun("kill-window", "-t", target);
  }

  async linkWindow(source: string, target: string, opts: { detached?: boolean } = {}): Promise<void> {
    const args: (string | number)[] = [];
    if (opts.detached !== false) args.push("-d");
    args.push("-s", source, "-t", target);
    await this.run("link-window", ...args);
  }

  async unlinkWindow(target: string, opts: { killLastLink?: boolean } = {}): Promise<void> {
    const args: (string | number)[] = [];
    if (opts.killLastLink) args.push("-k");
    args.push("-t", target);
    await this.run("unlink-window", ...args);
  }

  async renameWindow(target: string, name: string): Promise<void> {
    await this.run("rename-window", "-t", target, name);
  }

  async setWindowOption(target: string, option: string, value: string): Promise<void> {
    await this.run("set-window-option", "-t", target, option, value);
  }

  // --- Panes ---

  /** Get all pane IDs across all sessions — single tmux call. */
  async listPaneIds(): Promise<Set<string>> {
    try {
      const raw = await this.run("list-panes", "-a", "-F", "#{pane_id}");
      return new Set(raw.split("\n").filter(Boolean));
    } catch { return new Set(); }
  }

  /** Get structured info for all panes across all sessions. */
  async listPanes(): Promise<TmuxPane[]> {
    try {
      const raw = await this.run("list-panes", "-a", "-F",
        "#{pane_id}|||#{pane_current_command}|||#{session_name}:#{window_name}.#{pane_index}|||#{pane_title}|||#{pane_pid}|||#{pane_current_path}|||#{window_activity}|||#{pane_top}|||#{pane_left}|||#{pane_width}|||#{pane_height}|||#{pane_index}|||#{window_index}|||#{window_name}|||#{pane_active}|||#{window_width}|||#{window_height}|||#{window_active}|||#{session_attached}|||#{pane_dead}");
      const num = (value: string | undefined) => {
        if (value === undefined || value === "") return undefined;
        const n = Number(value);
        return Number.isFinite(n) ? n : undefined;
      };
      const bool = (value: string | undefined) => value === "1" || value === "true";
      return raw.split("\n").filter(Boolean).flatMap(line => {
        const parts = line.split("|||");
        if (parts.length < 3) return [];
        const [id, command, target, title, pid, cwd, winAct, top, left, paneW, paneH, paneIdx, winIdx, winName, paneActive, winW, winH, winActive, attached, dead] = parts;
        if (!id?.startsWith("%") || !target || bool(dead)) return [];
        const attachedClients = num(attached) ?? 0;
        return [{
          id,
          command,
          target,
          title,
          pid: num(pid),
          cwd: cwd || undefined,
          lastActivity: num(winAct),
          top: num(top),
          left: num(left),
          w: num(paneW),
          h: num(paneH),
          paneIdx: num(paneIdx),
          winIdx: num(winIdx),
          winName: winName || undefined,
          active: bool(paneActive),
          window: { w: num(winW), h: num(winH), active: bool(winActive) },
          attached: attachedClients > 0,
          ...(attachedClients > 1 ? { attachedClients } : {}),
        }];
      });
    } catch { return []; }
  }

  /** Kill a single pane (best-effort — swallows errors). */
  async killPane(target: string): Promise<void> {
    await this.tryRun("kill-pane", "-t", target);
  }

  /** Get the command running in a pane (e.g. "claude", "zsh") */
  async getPaneCommand(target: string): Promise<string> {
    const raw = await this.run("list-panes", "-t", target, "-F", "#{pane_current_command}");
    return raw.split("\n")[0] || "";
  }

  /** Batch-check which panes are running what command — single tmux call. */
  async getPaneCommands(targets: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    try {
      // Single call: list ALL panes with session:window_index + command
      const raw = await this.run("list-panes", "-a", "-F", "#{session_name}:#{window_index}|||#{pane_current_command}");
      const targetSet = new Set(targets);
      for (const line of raw.split("\n").filter(Boolean)) {
        const [target, cmd] = line.split("|||");
        if (targetSet.has(target)) result[target] = cmd || "";
      }
    } catch { /* expected: tmux may not be running */ }
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
      try { result[t] = await this.getPaneInfo(t); } catch { /* expected: pane may have closed */ }
    }));
    return result;
  }

  async capture(target: string, lines = 80): Promise<string> {
    const safeLines = Math.max(1, Math.floor(lines));
    return this.run("capture-pane", "-t", target, "-e", "-p", "-S", -safeLines);
  }

  async resizePane(target: string, cols: number, rows: number): Promise<void> {
    const c = Math.max(1, Math.min(cfgLimit("ptyCols"), Math.floor(cols)));
    const r = Math.max(1, Math.min(cfgLimit("ptyRows"), Math.floor(rows)));
    await this.tryRun("resize-pane", "-t", target, "-x", c, "-y", r);
  }

  async resizeWindow(target: string, cols: number, rows: number): Promise<void> {
    const c = Math.max(1, Math.min(cfgLimit("ptyCols"), Math.floor(cols)));
    const r = Math.max(1, Math.min(cfgLimit("ptyRows"), Math.floor(rows)));
    await this.tryRun("resize-window", "-t", target, "-x", c, "-y", r);
  }

  async splitWindow(target?: string, opts: {
    cwd?: string;
    command?: string;
    printFormat?: string;
    direction?: "horizontal" | "vertical";
    fullWindow?: boolean;
  } = {}): Promise<string> {
    const args: (string | number)[] = [];
    if (opts.printFormat) args.push("-P", "-F", opts.printFormat);
    if (opts.fullWindow) args.push("-f");
    if (opts.direction === "horizontal") args.push("-h");
    if (opts.direction === "vertical") args.push("-v");
    if (target) args.push("-t", target);
    if (opts.cwd) args.push("-c", opts.cwd);
    if (opts.command) args.push(opts.command);
    return this.run("split-window", ...args);
  }

  async selectPane(target: string, opts: { title?: string } = {}): Promise<void> {
    const args: (string | number)[] = ["-t", target];
    if (opts.title) args.push("-T", opts.title);
    await this.run("select-pane", ...args);
  }

  async selectLayout(target: string, layout: string): Promise<void> {
    await this.run("select-layout", "-t", target, layout);
  }

  /** Attach a client in tmux read-only mode (`attach-session -r`). */
  async attachReadonly(session: string): Promise<void> {
    await this.run("attach-session", "-r", "-t", session);
  }

  /**
   * Pipe pane output and/or shell-command output through tmux `pipe-pane`.
   *
   * tmux defaults to output mode (`-O`) when neither `input` nor `output` is
   * set; this wrapper makes the default explicit for callers and tests. Omit
   * `command` to close the current pipe for the target pane.
   */
  async pipePane(target: string, command?: string, opts: {
    /** Connect shell-command stdout to the pane as typed input (`-I`). */
    input?: boolean;
    /** Connect pane output to shell-command stdin (`-O`). Default true. */
    output?: boolean;
    /** Only open a new pipe if none exists (`-o`). */
    onlyIfClosed?: boolean;
  } = {}): Promise<void> {
    if (command === undefined) {
      await this.run("pipe-pane", "-t", target);
      return;
    }
    const args: (string | number)[] = [];
    const input = opts.input === true;
    const output = opts.output !== false || !input;
    if (input) args.push("-I");
    if (output) args.push("-O");
    if (opts.onlyIfClosed) args.push("-o");
    args.push("-t", target, command);
    await this.run("pipe-pane", ...args);
  }

  /** Toggle tmux synchronize-panes for a target window. */
  async synchronizePanes(target: string, on: boolean): Promise<void> {
    await this.run("set-window-option", "-t", target, "synchronize-panes", on ? "on" : "off");
  }

  // --- Keys ---

  async sendKeys(target: string, ...keys: string[]): Promise<void> {
    await this.run("send-keys", "-t", target, ...keys);
  }

  async sendKeysLiteral(target: string, text: string): Promise<void> {
    await this.run("send-keys", "-t", target, "-l", text);
  }

  /**
   * Leave copy-mode / transient tmux modes before delivering text.
   *
   * tmux `send-keys -l` is not mode-safe: in copy-mode literal text is still
   * interpreted by the mode key table, so uppercase/status text can exit the
   * mode mid-string and make tmux print repeated "not in a mode" errors for
   * the remaining characters. `maw hey` wants message delivery, not copy-mode
   * navigation, so high-level text sends normalize the pane first while raw
   * `Tmux.sendKeys()` remains available for callers that intentionally drive
   * tmux modes.
   */
  async exitModeIfNeeded(target: string): Promise<boolean> {
    let inMode = false;
    try {
      inMode = (await this.run("display-message", "-t", target, "-p", "#{pane_in_mode}")).trim() === "1";
    } catch {
      // If the probe fails, let the subsequent send surface the real target
      // error (for example "can't find pane") instead of hiding it here.
      return false;
    }
    if (!inMode) return false;
    try {
      await this.run("send-keys", "-t", target, "-X", "cancel");
      return true;
    } catch (e: any) {
      // The pane can leave copy-mode between probe and cancel; that race is
      // harmless and should not block delivery.
      if (String(e?.message ?? e).includes("not in a mode")) return false;
      throw e;
    }
  }

  // --- Buffers ---

  async loadBuffer(text: string): Promise<void> {
    const escaped = text.replace(/'/g, "'\\''");
    const socketFlag = this.socket ? `-S ${q(this.socket)} ` : "";
    const cmd = `printf '%s' '${escaped}' | tmux ${socketFlag}load-buffer -`;
    await hostExec(cmd, this.host);
  }

  async pasteBuffer(target: string): Promise<void> {
    await this.run("paste-buffer", "-t", target);
  }

  /**
   * Smart text sending — uses load-buffer for multiline/long messages,
   * send-keys for short single-line. Always submits with Enter.
   * Ported from old bash maw hey (Dec 2025).
   *
   * #6 — submit is now confirmed, not fire-and-forget. After placing the
   * text we send Enter, re-inspect the pane, and retry the Enter only while
   * the input line still holds un-submitted content (up to
   * MAX_SUBMIT_ATTEMPTS). This closes the trailing-Enter race where blind
   * staggered Enter keys landed before the pane was ready and the command
   * was silently left unexecuted.
   */
  async sendText(target: string, text: string): Promise<void> {
    await this.exitModeIfNeeded(target);
    if (text.includes("\n") || text.length > 500) {
      // Buffer method — reliable for multiline/long content
      await this.loadBuffer(text);
      await this.pasteBuffer(target);
    } else {
      // Literal send — -l prevents tmux from interpreting special chars like |
      await this.sendKeysLiteral(target, text);
    }
    await new Promise(r => setTimeout(r, SEND_SETTLE_MS));
    await this.submitWithConfirm(target, text);
  }

  /**
   * Send Enter, then confirm the input line cleared before returning. Retries
   * the Enter while input is still pending — see sendText for the #6 race.
   * @internal — exported behavior is exercised via sendText in tests.
   */
  private async submitWithConfirm(target: string, sentText: string): Promise<void> {
    for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
      await this.sendKeys(target, "Enter");
      await new Promise(r => setTimeout(r, SUBMIT_CONFIRM_MS));
      if (!(await this.paneInputPending(target, sentText))) return; // submitted — done
    }
    // Exhausted every retry and the input line still looks non-empty. The
    // caller has no visibility into tmux pane state, so warn loudly — a
    // silently-dropped dispatch is the exact failure mode #6 is about.
    console.warn(
      `[tmux] sendText: ${target} still shows pending input after ${MAX_SUBMIT_ATTEMPTS} Enter attempts — command may not have submitted`,
    );
  }

  /**
   * True when the pane's input line still holds the text we just sent. Prefer
   * sent-text visibility over prompt markers so submit confirmation works for
   * any engine prompt. A prompt-marker fallback, including Codex's U+203A `›`,
   * keeps legacy detection working when panes transform or truncate the text.
   * A read failure returns false (assume submitted) so a flaky capture can't
   * spin the retry loop.
   */
  private async paneInputPending(target: string, sentText: string): Promise<boolean> {
    try {
      const content = await this.capture(target, 5);
      const lines = content.split("\n").filter(l => l.trim());
      const last = (lines.at(-1) ?? "").replace(ANSI_RE, "").replace(/\r/g, "");
      const sentNeedles = pendingInputNeedles(sentText);
      if (sentNeedles.some(needle => last.includes(needle))) return true;

      // Fallback: prompt marker followed by non-whitespace → user/command text
      // still sitting on the input line. Includes Codex `›` for immediate #2380
      // relief while sent-text detection handles unknown future engines.
      // The marker must not follow a word character: engine status bars like
      // "Context 62% left" carry `% l` mid-line and are not pending input,
      // while real prompts ("agent@host:~$ cmd", "❯ cmd") keep matching.
      return /(?<!\w)[#$%>❯»›]\s+\S/.test(last);
    } catch {
      return false;
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

/** Default tmux instance (uses default host from hostExec config). */
export const tmux = new Tmux();
