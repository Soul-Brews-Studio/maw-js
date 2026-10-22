import { tmux, tmuxCmd } from "./tmux";
import { loadConfig, cfgTimeout, cfgLimit } from "../../config";
import type { MawWS } from "../types";

type PtyProc = ReturnType<typeof Bun.spawn>;
type PtySpawn = typeof Bun.spawn;
// Async capture-pane seam. Returns decoded stdout bytes (matches the binary
// frame shape the websocket wants) and the process exit code. Replaces the
// old spawnSync-based seam so replayCapture no longer blocks the event loop.
export type PtyCaptureResult = { stdout: Uint8Array; exitCode: number };
export type PtySpawnCapture = (args: string[]) => Promise<PtyCaptureResult>;
// listSessionGroups is optional: production always has it (real `tmux` is
// spread into ptyDeps), but injected test mocks may omit it — in which case
// the orphan sweep (#P2) and attach-time grouped-orphan kill (#P3) no-op
// rather than throw.
type PtyTmux = Pick<typeof tmux, "newGroupedSession" | "setOption" | "killSession">
  & Partial<Pick<typeof tmux, "listSessionGroups">>;

export interface PtyDeps {
  tmux: PtyTmux;
  tmuxCmd: typeof tmuxCmd;
  loadConfig: typeof loadConfig;
  cfgTimeout: typeof cfgTimeout;
  cfgLimit: typeof cfgLimit;
  spawn: PtySpawn;
  /** Async replacement for the old `spawnSync` capture-pane seam. */
  spawnCapture: PtySpawnCapture;
  env: () => NodeJS.ProcessEnv;
  platform: () => NodeJS.Platform;
  now: () => number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

async function defaultSpawnCapture(args: string[]): Promise<PtyCaptureResult> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
  const stdout = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

export function ptyDeps(overrides: Partial<PtyDeps> = {}): PtyDeps {
  return {
    tmux,
    tmuxCmd,
    loadConfig,
    cfgTimeout,
    cfgLimit,
    spawn: ((args, opts) => Bun.spawn(args, opts)) as PtySpawn,
    spawnCapture: defaultSpawnCapture,
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
  /** #P2 — kill maw-pty-* tmux sessions no longer tracked in-memory. */
  sweepOrphanPtySessions: () => Promise<{ killed: string[]; checked: number }>;
}

function replayLinesFromControl(value: unknown): number {
  if (value === undefined) return 2000;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 2000;
  return Math.max(0, Math.min(10_000, Math.floor(n)));
}

// Runs tmux capture-pane asynchronously and sends the scrollback to `ws`.
// Ordering guarantee: callers must not let live PTY output reach `ws` until
// this promise settles (see attach()'s two call sites for how each is kept
// safe now that capture is no longer a blocking spawnSync call).
async function replayCapture(ws: MawWS, target: string, lines: number, io: PtyDeps): Promise<void> {
  if (lines <= 0) return;
  try {
    const cap = await io.spawnCapture(["tmux", "capture-pane", "-t", target, "-p", "-e", "-J", "-S", `-${lines}`]);
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
  // PTY session names generated but not yet committed to `sessions` (the
  // newGroupedSession→setOption→spawn window). The sweep/attach-kill must treat
  // these as live so a sweep landing mid-create can't reap a session we're
  // about to track and disconnect the Oracle that just attached.
  const creatingPtyNames = new Set<string>();

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

// True when a maw-pty-* tmux session is one we own — either committed to
// `sessions` or mid-create. Neither must ever be reaped.
function isTrackedPtyName(ptyName: string): boolean {
  if (creatingPtyNames.has(ptyName)) return true;
  for (const s of sessions.values()) {
    if (s.ptySessionName === ptyName) return true;
  }
  return false;
}

// #P2 — periodic orphan sweep. Kills maw-pty-* tmux sessions that exist
// server-side but are no longer tracked in-memory (in-memory/tmux drift WITHIN
// a single server lifecycle — e.g. a kill that raced cleanup, or a future
// dead-client miss). The boot-time reaper (server.ts #300) already clears the
// server-RESTART class on startup; this handles runtime drift on a long-lived
// process. Tracked/attached sessions are always skipped, so a live Oracle
// terminal is never touched.
async function sweepOrphanPtySessions(): Promise<{ killed: string[]; checked: number }> {
  if (!io.tmux.listSessionGroups) return { killed: [], checked: 0 };
  const all = await io.tmux.listSessionGroups();
  const killed: string[] = [];
  for (const { name } of all) {
    if (!name.startsWith("maw-pty-")) continue;
    if (isTrackedPtyName(name)) continue;
    await io.tmux.killSession(name); // best-effort; killSession swallows errors
    killed.push(name);
  }
  return { killed, checked: all.length };
}

// #P3 — at attach time, remove any pre-existing maw-pty-* sessions grouped to
// the SAME parent that we don't track. Grouped sessions share the parent's
// window size, so a stale grouped client (e.g. a frozen 45x30 tab) shrinks the
// real window — the "size-hijack" vector. Group name == parent session name
// (verified on live tmux). Untracked-only + group-scoped → never kills a live
// terminal on this or any other Oracle.
async function killStaleGroupedSessions(parent: string): Promise<void> {
  if (!io.tmux.listSessionGroups) return;
  const all = await io.tmux.listSessionGroups();
  for (const { name, group } of all) {
    if (!name.startsWith("maw-pty-")) continue;
    if (group !== parent) continue;
    if (isTrackedPtyName(name)) continue;
    await io.tmux.killSession(name);
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
    else if (data.type === "detach") { detach(ws); bumpAttachEpoch(ws); }
  } catch { /* expected: malformed WS message */ }
}

function handlePtyClose(ws: MawWS) {
  detach(ws);
  bumpAttachEpoch(ws);
}

// Per-ws attach epoch. Because replayCapture() is now async, an attach() has a
// suspension window (the awaited capture) during which the socket can close,
// send {type:"detach"}, or fire another {type:"attach"} — and by the time it
// resumes, registering `ws` as a live viewer or sending "attached" may be
// wrong. Each of those events bumps this counter; attach() snapshots it at
// entry (`myEpoch`) and re-checks after every await that precedes viewer
// registration or a ws.send. If it changed, a newer event superseded this
// attach, so it aborts its registration. This is correct under all
// interleavings — a *stale* detach can never abort a *later* attach, because
// that later attach bumped the epoch past the detach's value. (The previous
// one-shot `abandonedAttach` WeakSet flag was not: a detach set a sticky flag
// that a subsequent re-attach on the same socket would wrongly consume,
// silently dropping the re-attach. A duplicate concurrent attach likewise just
// bumps the epoch, so the newest attach wins and the older in-flight one aborts
// — which also subsumes the old `joiningCached` guard.)
const attachEpoch = new WeakMap<MawWS, number>();
function bumpAttachEpoch(ws: MawWS): number {
  const next = (attachEpoch.get(ws) ?? 0) + 1;
  attachEpoch.set(ws, next);
  return next;
}

async function attach(ws: MawWS, target: string, cols: number, rows: number, replayLines: number) {
  // Sanitize target: only allow safe characters
  const safe = target.replace(/[^a-zA-Z0-9\-_:.]/g, "");
  if (!safe) return;

  // Detach from any existing session
  detach(ws);

  // Snapshot the attach epoch: any detach/close/re-attach on this socket during
  // an awaited replayCapture() below bumps it, and we re-check before joining.
  const myEpoch = bumpAttachEpoch(ws);

  // Join existing PTY session?
  const cached = sessions.get(safe);
  if (cached) {
    if (cached.cleanupTimer) {
      io.clearTimeout(cached.cleanupTimer);
      cached.cleanupTimer = null;
    }
    // ORDERING GUARANTEE: the replay must reach `ws` before any live PTY
    // output does. The PTY output loop below only ever sends to sockets in
    // `session.viewers` — so as long as `ws` is deferred out of that set
    // until replayCapture() has finished sending, no live frame can reach it
    // early. That's exactly what happens here: `ws` is not added to
    // `cached.viewers` until after the await below, so this is a deferred
    // *registration* rather than a buffer-and-flush — there is nothing to
    // buffer because `ws` was never a valid delivery target during capture.
    await replayCapture(ws, safe, replayLines, io);

    // Socket closed/detached, or a newer attach for this socket started, while
    // capture was in flight → don't (re)join or write further (see attachEpoch).
    if (attachEpoch.get(ws) !== myEpoch) return;
    cached.viewers.add(ws);
    try { ws.send(JSON.stringify({ type: "attached", target: safe })); } catch { /* expected: viewer may have disconnected */ }
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
  creatingPtyNames.add(ptySessionName);

  // #P3 — clear any stale grouped orphan on this parent so a leftover frozen
  // client can't shrink the shared window. Fire-and-forget: it runs alongside
  // session creation (killSession is idempotent and tmux resizes the window
  // after a client leaves regardless of order), and the new ptySessionName is
  // already in creatingPtyNames so the kill can never reap the session we are
  // about to track. Keeps attach latency off the tmux-list round-trip.
  void killStaleGroupedSessions(sessionName).catch(() => { /* expected: tmux listing may transiently fail */ });

  try {
    await io.tmux.newGroupedSession(sessionName, ptySessionName, {
      cols: c, rows: r, window: windowPart || undefined,
    });
    // Hide status bar in PTY sessions so it doesn't appear in terminal output
    await io.tmux.setOption(ptySessionName, "status", "off").catch(() => { /* expected: option may not apply */ });
  } catch {
    creatingPtyNames.delete(ptySessionName);
    attaching.delete(safe);
    try { ws.send(JSON.stringify({ type: "error", message: "Failed to create PTY session" })); } catch { /* expected: viewer may have disconnected */ }
    return;
  }

  // Replay scrollback history so xterm.js can scroll up. Without this, tmux
  // attach only redraws current pane → viewer's local buffer has no history.
  // capture-pane reads tmux server-side history (limit set by history-limit).
  // -p stdout, -e include ANSI attrs, -S -2000 last 2000 lines, -J join wrapped.
  //
  // ORDERING GUARANTEE: this is awaited BEFORE io.spawn() below creates the
  // live PTY wrapper process. No PTY process (and therefore no live output
  // loop) exists yet at this point, so there is no possibility of live data
  // reaching `ws` ahead of the replay — the guarantee holds structurally
  // rather than by buffering.
  await replayCapture(ws, safe, replayLines, io);

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

  // Viewer may have closed/detached (or started a newer attach) while we were
  // creating the grouped tmux session and awaiting replayCapture() above. The
  // grouped session is still spawned and tracked either way — abandoning it
  // here would leak an untracked maw-pty-* session outside `sessions`
  // (unreachable by #P2/#P3 until the wrapper process exits on its own) — but
  // we don't register the departed/superseded socket as a viewer, matching the
  // pre-async behavior where a vanished `ws` simply wouldn't receive further
  // sends (see attachEpoch).
  const initialViewers = attachEpoch.get(ws) === myEpoch ? [ws] : [];
  const session: PtySession = { proc, target: safe, ptySessionName, viewers: new Set(initialViewers), cleanupTimer: null };
  sessions.set(safe, session);
  creatingPtyNames.delete(ptySessionName); // now tracked via `sessions`
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

  return { handlePtyMessage, handlePtyClose, sweepOrphanPtySessions };
}

const defaultPtyHandlers = createPtyHandlers();

export const handlePtyMessage = defaultPtyHandlers.handlePtyMessage;
export const handlePtyClose = defaultPtyHandlers.handlePtyClose;
export const sweepOrphanPtySessions = defaultPtyHandlers.sweepOrphanPtySessions;
