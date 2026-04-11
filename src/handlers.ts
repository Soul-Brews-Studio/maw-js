import { sendKeys, selectWindow, ssh, getPaneCommand } from "./ssh";
import { tmux } from "./tmux";
import { buildCommand } from "./config";
import type { MawWS, Handler, MawEngine } from "./types";

/** Run an async action with standard ok/error response */
async function runAction(ws: MawWS, action: string, target: string, fn: () => Promise<void>) {
  try {
    await fn();
    ws.send(JSON.stringify({ type: "action-ok", action, target }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
}

// --- Handlers ---

const subscribe: Handler = (ws, data, engine) => {
  ws.data.target = data.target;
  engine.pushCapture(ws);
};

const subscribePreviews: Handler = (ws, data, engine) => {
  ws.data.previewTargets = new Set(data.targets || []);
  engine.pushPreviews(ws);
};

const select: Handler = (_ws, data) => {
  selectWindow(data.target).catch(() => { /* expected: window may not exist */ });
};

const send: Handler = async (ws, data, engine) => {
  // Check for active Claude session before sending (#17)
  if (!data.force) {
    try {
      const cmd = await getPaneCommand(data.target);
      if (!/claude|codex|node/i.test(cmd)) {
        ws.send(JSON.stringify({ type: "error", error: `no active Claude session in ${data.target} (running: ${cmd})` }));
        return;
      }
    } catch { /* pane check failed, proceed anyway */ }
  }
  sendKeys(data.target, data.text)
    .then(() => {
      const ack: Record<string, unknown> = { type: "sent", ok: true, target: data.target, text: data.text };
      if (data.id) ack.id = data.id;
      ws.send(JSON.stringify(ack));
      setTimeout(() => engine.pushCapture(ws), 300);
    })
    .catch(e => {
      const err: Record<string, unknown> = { type: "error", error: e.message };
      if (data.id) err.id = data.id;
      ws.send(JSON.stringify(err));
    });
};

const sleep: Handler = (ws, data) => {
  runAction(ws, "sleep", data.target, () => sendKeys(data.target, "\x03"));
};

const stop: Handler = (ws, data) => {
  runAction(ws, "stop", data.target, () => tmux.killWindow(data.target));
};

const wake: Handler = async (ws, data) => {
  const cmd = data.command || buildCommand(data.target?.split(":").pop() || "");
  // Check if Claude is already running — skip wake to avoid polluting active session
  try {
    const paneCmd = await getPaneCommand(data.target);
    if (/claude|codex|node/i.test(paneCmd)) {
      ws.send(JSON.stringify({ type: "action-ok", action: "wake", target: data.target, note: "already running" }));
      return;
    }
  } catch { /* pane check failed, proceed with wake */ }
  runAction(ws, "wake", data.target, () => sendKeys(data.target, cmd + "\r"));
};

const restart: Handler = (ws, data) => {
  const cmd = data.command || buildCommand(data.target?.split(":").pop() || "");
  runAction(ws, "restart", data.target, async () => {
    await sendKeys(data.target, "\x03"); // Ctrl+C
    await new Promise(r => setTimeout(r, 2000));
    await sendKeys(data.target, "\x03"); // Ctrl+C again (in case first was caught)
    await new Promise(r => setTimeout(r, 500));
    await sendKeys(data.target, cmd + "\r");
  });
};

const kill: Handler = (ws, data) => {
  runAction(ws, "kill", data.target, () => tmux.killWindow(data.target));
};

/**
 * Whitelist of POSIX signals the WebSocket `signal` handler may forward.
 * Matches the set `kill(1)` on Linux + macOS accepts by name plus the
 * numeric fallbacks we actually use from the CLI. Anything not in this
 * set — including anything with a shell metacharacter — is rejected at
 * the handler layer before `ssh()` is ever called.
 */
const ALLOWED_SIGNALS = new Set([
  // Symbolic names (with or without SIG prefix)
  "SIGHUP", "HUP",
  "SIGINT", "INT",
  "SIGQUIT", "QUIT",
  "SIGKILL", "KILL",
  "SIGUSR1", "USR1",
  "SIGUSR2", "USR2",
  "SIGTERM", "TERM",
  "SIGCONT", "CONT",
  "SIGSTOP", "STOP",
  "SIGTSTP", "TSTP",
  "SIGWINCH", "WINCH",
  // Numeric equivalents for the names above
  "1", "2", "3", "9", "10", "12", "15", "18", "19", "20", "28",
]);

/**
 * Shape check for the signal name. Belt-and-suspenders: even if a new
 * entry is added to ALLOWED_SIGNALS in the future, a regex rejection
 * of anything containing whitespace, `$`, backtick, `;`, `&`, `|`, `(`,
 * `)`, or quotes ensures the string cannot smuggle shell metacharacters
 * through. Anchored, bounded length, no backtracking risk.
 */
const SIGNAL_SHAPE = /^(SIG[A-Z]{1,8}|[A-Z]{1,8}|[0-9]{1,2})$/;

const signal: Handler = async (ws, data) => {
  const raw = typeof data.signal === "string" && data.signal.length > 0 ? data.signal : "SIGTERM";

  // Validate BEFORE ssh() call. Two layers:
  // 1. Regex shape check — cheap anchored guard, rejects any string with
  //    shell metacharacters or whitespace before touching the Set lookup.
  // 2. Explicit allowlist — only signals we actually use get forwarded.
  if (!SIGNAL_SHAPE.test(raw) || !ALLOWED_SIGNALS.has(raw)) {
    // Log only the length, never the raw payload (NEW-13 avoidance).
    console.warn(`[handlers] rejected signal (len=${raw.length})`);
    ws.send(JSON.stringify({ type: "error", error: "invalid signal name" }));
    return;
  }
  const sig = raw;

  runAction(ws, "signal", data.target, async () => {
    // Get pane PID then send signal
    const pid = await tmux.run("display-message", "-t", data.target, "-p", "#{pane_pid}");
    const trimmedPid = pid.trim();
    if (!trimmedPid || isNaN(Number(trimmedPid))) throw new Error("Could not get pane PID");
    // `sig` is now a validated whitelist member (no shell metacharacters
    // possible) and `trimmedPid` passed an isNaN guard. The durable
    // argv-form fix for src/ssh.ts is scheduled for Round 5.
    await ssh(`kill -${sig} ${trimmedPid}`);
  });
};

/** Register all built-in WebSocket handlers on the engine */
export function registerBuiltinHandlers(engine: MawEngine) {
  engine.on("subscribe", subscribe);
  engine.on("subscribe-previews", subscribePreviews);
  engine.on("select", select);
  engine.on("send", send);
  engine.on("sleep", sleep);
  engine.on("stop", stop);
  engine.on("wake", wake);
  engine.on("restart", restart);
  engine.on("kill", kill);
  engine.on("signal", signal);
}
