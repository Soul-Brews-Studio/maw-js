import { tmux, tmuxCmd } from "./tmux";
import { loadConfig, cfgTimeout, cfgLimit } from "../../config";
import type { MawWS } from "../types";

type PtyProc = ReturnType<typeof Bun.spawn>;
type PtySpawn = typeof Bun.spawn;
type PtySpawnSync = typeof Bun.spawnSync;
type PtyTmux = Pick<typeof tmux, "newGroupedSession" | "setOption" | "killSession">;

export interface PtyDeps {
  tmux: PtyTmux;
  tmuxCmd: typeof tmuxCmd;
  loadConfig: typeof loadConfig;
  cfgTimeout: typeof cfgTimeout;
  cfgLimit: typeof cfgLimit;
  spawn: PtySpawn;
  spawnSync: PtySpawnSync;
  env: () => NodeJS.ProcessEnv;
  platform: () => NodeJS.Platform;
  now: () => number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export function ptyDeps(overrides: Partial<PtyDeps> = {}): PtyDeps {
  return {
    tmux,
    tmuxCmd,
    loadConfig,
    cfgTimeout,
    cfgLimit,
    spawn: ((args, opts) => Bun.spawn(args, opts)) as PtySpawn,
    spawnSync: ((args) => Bun.spawnSync(args)) as PtySpawnSync,
    env: () => process.env,
    platform: () => process.platform,
    now: () => Date.now(),
    setTimeout,
    clearTimeout,
    ...overrides,
  };
}

interface PtySession {
  proc: PtyProc;
  target: string;
  ptySessionName: string;
  viewers: Set<MawWS>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

interface PtyHandlers {
  handlePtyMessage: (ws: MawWS, msg: string | Buffer) => void;
  handlePtyClose: (ws: MawWS) => void;
}

function replayLinesFromControl(value: unknown): number {
  if (value === undefined) return 2000;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 2000;
  return Math.max(0, Math.min(10_000, Math.floor(n)));
}

function replayCapture(ws: MawWS, target: string, lines: number, io: PtyDeps) {
  if (lines <= 0) return;
  try {
    const cap = io.spawnSync(["tmux", "capture-pane", "-t", target, "-p", "-e", "-J", "-S", `-${lines}`]);
    if (cap.stdout && cap.stdout.length > 0) {
      ws.send(cap.stdout);
      ws.send(new TextEncoder().encode("\r\n"));
    }
  } catch { /* expected: capture-pane may fail if target gone or tmux missing */ }
}

export function createPtyHandlers(overrides: Partial<PtyDeps> = {}): PtyHandlers {
  const io = ptyDeps(overrides);
  let nextPtyId = 0;
  const sessions = new Map<string, PtySession>();
  const attaching = new Set<string>();

function isLocalHost(): boolean {
  // #713: with bind/host split, config.host is never a bind address (0.0.0.0 etc.)
  const host = io.env().MAW_HOST || io.loadConfig().host || "local";
  return host === "local" || host === "localhost";
}

function findSession(ws: MawWS): PtySession | undefined {
  for (const s of sessions.values()) {
    if (s.viewers.has(ws)) return s;
  }
}

function handlePtyMessage(ws: MawWS, msg: string | Buffer) {
  if (typeof msg !== "string") {
    // Binary → keystroke to PTY stdin
    const session = findSession(ws);
    if (session?.proc.stdin) {
      session.proc.stdin.write(msg as Buffer);
      session.proc.stdin.flush();
    }
    return;
  }

  // JSON control message
  try {
    const data = JSON.parse(msg);
    if (data.type === "attach") attach(ws, data.target, data.cols || 120, data.rows || 40, replayLinesFromControl(data.replayLines));
    else if (data.type === "resize") resize(ws, data.cols, data.rows);
    else if (data.type === "detach") detach(ws);
  } catch { /* expected: malformed WS message */ }
}

function handlePtyClose(ws: MawWS) {
  detach(ws);
}

async function attach(ws: MawWS, target: string, cols: number, rows: number, replayLines: number) {
  // Sanitize target: only allow safe characters
  const safe = target.replace(/[^a-zA-Z0-9\-_:.]/g, "");
  if (!safe) return;

  // Detach from any existing session
  detach(ws);

  // Join existing PTY session?
  let session = sessions.get(safe);
  if (session) {
    if (session.cleanupTimer) {
      io.clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }
    session.viewers.add(ws);
    // Late viewer: cached PTY only streams *new* output, so without a replay
    // the screen stays empty until something happens in the pane → looks like
    // "black pane covering tmux". Mirror the new-session capture-pane block.
    replayCapture(ws, safe, replayLines, io);
    ws.send(JSON.stringify({ type: "attached", target: safe }));
    return;
  }

  // Mutex: prevent concurrent creation for the same target
  if (attaching.has(safe)) return;
  attaching.add(safe);

  const sessionName = safe.split(":")[0];
  const windowPart = safe.includes(":") ? safe.split(":").slice(1).join(":") : "";
  const c = Math.max(1, Math.min(io.cfgLimit("ptyCols"), Math.floor(cols)));
  const r = Math.max(1, Math.min(io.cfgLimit("ptyRows"), Math.floor(rows)));

  // Create a grouped session — shares windows but has independent client sizing.
  // This prevents the web terminal from shrinking the real terminal.
  const ptySessionName = `maw-pty-${io.now()}-${++nextPtyId}`;
  try {
    await io.tmux.newGroupedSession(sessionName, ptySessionName, {
      cols: c, rows: r, window: windowPart || undefined,
    });
    // Hide status bar in PTY sessions so it doesn't appear in terminal output
    await io.tmux.setOption(ptySessionName, "status", "off").catch(() => { /* expected: option may not apply */ });
  } catch {
    attaching.delete(safe);
    ws.send(JSON.stringify({ type: "error", message: "Failed to create PTY session" }));
    return;
  }

  // Replay scrollback history so xterm.js can scroll up. Without this, tmux
  // attach only redraws current pane → viewer's local buffer has no history.
  // capture-pane reads tmux server-side history (limit set by history-limit).
  // -p stdout, -e include ANSI attrs, -S -2000 last 2000 lines, -J join wrapped.
  replayCapture(ws, safe, replayLines, io);

  // Spawn PTY wrapper — attach to our grouped session (not the original).
  //
  // Linux (util-linux `script -qfc`): works fine; it creates a PTY internally
  // and doesn't care that Bun gives it a pipe for stdin.
  //
  // macOS (BSD `script`): calls tcgetattr() on its stdin at startup to copy
  // terminal settings into the new PTY. With `stdin: "pipe"` from Bun, that
  // ioctl fails with "Operation not supported on socket" → script exits
  // immediately → stdout reader sees EOF → we fire {type:"detached"} before
  // anything attaches. This was the mystery "[session detached]" on every
  // click in the lens on macOS hosts.
  //
  // Fix on darwin: use `/usr/bin/expect` which allocates its own PTY (ptyfork)
  // without probing caller's stdin. `spawn -noecho` silences the echo of the
  // command; `interact` bridges stdin↔PTY↔stdout so keystrokes flow to the
  // tmux session and output streams back. expect(1) ships preinstalled on
  // every macOS.
  let args: string[];
  if (isLocalHost()) {
    const cmd = `stty rows ${r} cols ${c} 2>/dev/null; TERM=xterm-256color ${io.tmuxCmd()} attach-session -t '${ptySessionName}'`;
    if (io.platform() === "darwin") {
      // Shell-escape cmd for embedding inside expect's double-quoted string.
      const esc = cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
      args = ["/usr/bin/expect", "-c", `spawn -noecho sh -c "${esc}"; interact`];
    } else {
      args = ["script", "-qfc", cmd, "/dev/null"];
    }
  } else {
    const host = io.env().MAW_HOST || io.loadConfig().host || "local";
    args = ["ssh", "-tt", host, `TERM=xterm-256color ${io.tmuxCmd()} attach-session -t '${ptySessionName}'`];
  }

  const proc = io.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...io.env(), TERM: "xterm-256color" },
    windowsHide: true,
  });

  session = { proc, target: safe, ptySessionName, viewers: new Set([ws]), cleanupTimer: null };
  sessions.set(safe, session);
  attaching.delete(safe);

  // Stream PTY stdout → all viewers as binary frames
  // Send "attached" on first data — PTY is ready with content, no black screen
  const s = session;
  let sentAttached = false;
  const reader = proc.stdout!.getReader();
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!sentAttached) {
          for (const v of s.viewers) {
            try { v.send(JSON.stringify({ type: "attached", target: safe })); } catch { /* expected: viewer may have disconnected */ }
          }
          sentAttached = true;
        }
        for (const v of s.viewers) {
          try { v.send(value); } catch { /* expected: viewer may have disconnected */ }
        }
      }
    } catch { /* expected: PTY stream ended */ }
    // PTY process ended — clean up grouped session
    sessions.delete(safe);
    io.tmux.killSession(s.ptySessionName);
    for (const v of s.viewers) {
      try { v.send(JSON.stringify({ type: "detached", target: safe })); } catch { /* expected: viewer may have disconnected */ }
    }
  })();
}

function resize(_ws: MawWS, _cols: number, _rows: number) {
  // No-op: with grouped sessions, resize-pane would affect the shared pane
  // (shrinking the real terminal). The web terminal works at its initial size.
  // TODO: proper PTY resize via node-pty or ioctl
}

function detach(ws: MawWS) {
  for (const [target, session] of sessions) {
    if (!session.viewers.has(ws)) continue;
    session.viewers.delete(ws);
    if (session.viewers.size === 0) {
      // Grace period before killing PTY
      session.cleanupTimer = io.setTimeout(() => {
        try { session.proc.kill(); } catch { /* expected: process may already be dead */ }
        io.tmux.killSession(session.ptySessionName);
        sessions.delete(target);
      }, io.cfgTimeout("pty"));
    }
  }
}

  return { handlePtyMessage, handlePtyClose };
}

const defaultPtyHandlers = createPtyHandlers();

export const handlePtyMessage = defaultPtyHandlers.handlePtyMessage;
export const handlePtyClose = defaultPtyHandlers.handlePtyClose;
