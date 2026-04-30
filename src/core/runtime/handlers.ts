import { sendKeys, selectWindow, hostExec, getPaneCommand } from "../transport/ssh";
import { tmux } from "../transport/tmux";
import { buildCommand } from "../../config";
import { extractOracleName, resolveTargetCwd, shellQuote } from "../../commands/shared/target-cwd";
import type { MawWS, Handler, MawEngine } from "../types";

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
  // scope "main" (default) replaces ws.data.target — full /ws capture stream.
  // scope "preview" adds to previewTargets — used by FleetGrid pinned cards,
  //   VSAgentPanel, useMissionControl pin so they don't clobber the active
  //   TerminalView target on the same singleton WS (echo 2026-04-29).
  const scope = data.scope === "preview" ? "preview" : "main";
  if (scope === "main") {
    ws.data.target = data.target;
    engine.pushCapture(ws);
  } else {
    if (!ws.data.previewTargets) ws.data.previewTargets = new Set();
    ws.data.previewTargets.add(data.target);
    engine.pushPreviews(ws);
  }
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
      ws.send(JSON.stringify({ type: "sent", ok: true, target: data.target, text: data.text }));
      setTimeout(() => engine.pushCapture(ws), 300);
    })
    .catch(e => ws.send(JSON.stringify({ type: "error", error: e.message })));
};

const sleep: Handler = (ws, data) => {
  runAction(ws, "sleep", data.target, () => sendKeys(data.target, "\x03"));
};

const stop: Handler = (ws, data) => {
  runAction(ws, "stop", data.target, () => tmux.killWindow(data.target));
};

/**
 * Re-spawn claude in an existing pane. Two cases the bare `target.split(":").pop()`
 * extraction missed (Boss-flagged 2026-04-29 — pane spawned with the wrong
 * oracle's CLAUDE.md identity):
 *   1. `pop()` returns the window index ("0"), not the oracle name → `buildCommand`
 *      falls back to default rather than the oracle-specific command.
 *   2. `sendKeys` runs at the pane's *current* cwd; if the pane drifted
 *      (manual cd, tmux server reboot, kill+respawn) claude loads whatever
 *      CLAUDE.md is at that cwd instead of the intended oracle's.
 *
 * Fix:
 *   • Resolve oracle name from the session (`05-nari` → `nari`) for `buildCommand`.
 *   • Resolve the canonical cwd from fleet config and prepend `cd '<cwd>' && `
 *     when known. Non-fleet targets fall back to the bare cmd (pre-fix behavior).
 */
function buildSpawnCmd(data: { target?: string; command?: string; cwd?: string }): string {
  const target = data.target || "";
  const oracle = extractOracleName(target);
  const baseCmd = data.command || buildCommand(oracle);
  const cwd = data.cwd || resolveTargetCwd(target);
  return cwd ? `cd ${shellQuote(cwd)} && ${baseCmd}` : baseCmd;
}

const wake: Handler = (ws, data) => {
  const cmd = buildSpawnCmd(data);
  runAction(ws, "wake", data.target, () => sendKeys(data.target, cmd + "\r"));
};

const restart: Handler = (ws, data) => {
  const cmd = buildSpawnCmd(data);
  runAction(ws, "restart", data.target, async () => {
    await sendKeys(data.target, "\x03"); // Ctrl+C
    await new Promise(r => setTimeout(r, 2000));
    await sendKeys(data.target, "\x03"); // Ctrl+C again (in case first was caught)
    await new Promise(r => setTimeout(r, 500));
    await sendKeys(data.target, cmd + "\r");
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
}
