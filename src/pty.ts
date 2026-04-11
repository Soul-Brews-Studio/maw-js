import { tmux, tmuxCmd } from "./tmux";
import { loadConfig, cfgTimeout, cfgLimit } from "./config";
import type { ServerWebSocket } from "bun";

let nextPtyId = 0;

interface PtySession {
  proc: ReturnType<typeof Bun.spawn>;
  target: string;
  ptySessionName: string;
  viewers: Set<ServerWebSocket<any>>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, PtySession>();
const attaching = new Set<string>();

function isLocalHost(): boolean {
  const host = process.env.MAW_HOST || loadConfig().host || "local";
  return host === "local" || host === "localhost";
}

function findSession(ws: ServerWebSocket<any>): PtySession | undefined {
  for (const s of sessions.values()) {
    if (s.viewers.has(ws)) return s;
  }
}

export function handlePtyMessage(ws: ServerWebSocket<any>, msg: string | Buffer) {
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
    if (data.type === "attach") attach(ws, data.target, data.cols || 120, data.rows || 40);
    else if (data.type === "resize") resize(ws, data.cols, data.rows);
    else if (data.type === "detach") detach(ws);
  } catch { /* expected: malformed WS message */ }
}

export function handlePtyClose(ws: ServerWebSocket<any>) {
  detach(ws);
}

async function attach(ws: ServerWebSocket<any>, target: string, cols: number, rows: number) {
  // Sanitize target: only allow safe characters
  const safe = target.replace(/[^a-zA-Z0-9\-_:.]/g, "");
  if (!safe) return;

  // Detach from any existing session
  detach(ws);

  // Join existing PTY session?
  let session = sessions.get(safe);
  if (session) {
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }
    session.viewers.add(ws);
    ws.send(JSON.stringify({ type: "attached", target: safe }));
    return;
  }

  // Mutex: prevent concurrent creation for the same target
  if (attaching.has(safe)) return;
  attaching.add(safe);

  const sessionName = safe.split(":")[0];
  const windowPart = safe.includes(":") ? safe.split(":").slice(1).join(":") : "";
  const c = Math.max(1, Math.min(cfgLimit("ptyCols"), Math.floor(cols)));
  const r = Math.max(1, Math.min(cfgLimit("ptyRows"), Math.floor(rows)));

  // Create a grouped session — shares windows but has independent client sizing.
  // This prevents the web terminal from shrinking the real terminal.
  const ptySessionName = `maw-pty-${Date.now()}-${++nextPtyId}`;
  try {
    await tmux.newGroupedSession(sessionName, ptySessionName, {
      cols: c, rows: r, window: windowPart || undefined,
    });
    // Hide status bar in PTY sessions so it doesn't appear in terminal output
    await tmux.setOption(ptySessionName, "status", "off").catch(() => { /* expected: option may not apply */ });
  } catch {
    attaching.delete(safe);
    ws.send(JSON.stringify({ type: "error", message: "Failed to create PTY session" }));
    return;
  }

  // Spawn PTY via script(1) — attach to our grouped session (not the original)
  let args: string[];
  if (isLocalHost()) {
    const cmd = `stty rows ${r} cols ${c} 2>/dev/null; TERM=xterm-256color ${tmuxCmd()} attach-session -t '${ptySessionName}'`;
    args = ["script", "-qfc", cmd, "/dev/null"];
  } else {
    const host = process.env.MAW_HOST || loadConfig().host || "local";
    args = ["ssh", "-tt", host, `TERM=xterm-256color ${tmuxCmd()} attach-session -t '${ptySessionName}'`];
  }

  const proc = Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, TERM: "xterm-256color" },
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
    tmux.killSession(s.ptySessionName);
    for (const v of s.viewers) {
      try { v.send(JSON.stringify({ type: "detached", target: safe })); } catch { /* expected: viewer may have disconnected */ }
    }
  })();
}

function resize(_ws: ServerWebSocket<any>, _cols: number, _rows: number) {
  // No-op: with grouped sessions, resize-pane would affect the shared pane
  // (shrinking the real terminal). The web terminal works at its initial size.
  // TODO: proper PTY resize via node-pty or ioctl
}

function detach(ws: ServerWebSocket<any>) {
  for (const [target, session] of sessions) {
    if (!session.viewers.has(ws)) continue;
    session.viewers.delete(ws);
    if (session.viewers.size === 0) {
      // Grace period before killing PTY
      session.cleanupTimer = setTimeout(() => {
        try { session.proc.kill(); } catch { /* expected: process may already be dead */ }
        tmux.killSession(session.ptySessionName);
        sessions.delete(target);
      }, cfgTimeout("pty"));
    }
  }
}
