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

const signal: Handler = async (ws, data) => {
  const sig = data.signal || "SIGTERM";
  runAction(ws, "signal", data.target, async () => {
    // Get pane PID then send signal
    const pid = await tmux.run("display-message", "-t", data.target, "-p", "#{pane_pid}");
    const trimmedPid = pid.trim();
    if (!trimmedPid || isNaN(Number(trimmedPid))) throw new Error("Could not get pane PID");
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
