import { sendKeys, selectWindow, hostExec, getPaneCommand, isAgentCommand } from "../transport/ssh";
import { tmux } from "../transport/tmux";
import { buildCommand } from "../../config";
import { extractOracleName, resolveTargetCwd, shellQuote } from "../../commands/shared/target-cwd";
import type { MawWS, Handler, MawEngine } from "../types";

/** Run an async action with standard ok/error response */
async function runAction(ws: MawWS, action: string, target: string, fn: () => Promise<void>) {
  try {
    await fn();
    ws.send(JSON.stringify({ type: "action-ok", action, target }));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    ws.send(JSON.stringify({ type: "error", error: msg }));
  }
}

// --- Handlers ---

const subscribe: Handler = (ws, data, engine) => {
  // scope "main" (default) replaces ws.data.target — full /ws capture stream.
  // scope "preview" adds to previewTargets — used by FleetGrid pinned cards,
  //   VSAgentPanel, useMissionControl pin so they don't clobber the active
  //   TerminalView target on the same singleton WS (echo 2026-04-29).
  const d = data as { scope?: string; target: string };
  const scope = d.scope === "preview" ? "preview" : "main";
  if (scope === "main") {
    ws.data.target = d.target;
    engine.pushCapture(ws);
  } else {
    if (!ws.data.previewTargets) ws.data.previewTargets = new Set();
    ws.data.previewTargets.add(d.target);
    engine.pushPreviews(ws);
  }
};

const subscribePreviews: Handler = (ws, data, engine) => {
  const d = data as { targets?: string[] };
  ws.data.previewTargets = new Set(d.targets || []);
  engine.pushPreviews(ws);
};

const select: Handler = (_ws, data) => {
  const d = data as { target: string };
  selectWindow(d.target).catch(() => { /* expected: window may not exist */ });
};

const send: Handler = async (ws, data, engine) => {
  // Check for active Claude session before sending (#17)
  const d = data as { force?: boolean; target: string; text: string };
  if (!d.force) {
    try {
      const cmd = await getPaneCommand(d.target);
      if (!isAgentCommand(cmd)) {
        ws.send(JSON.stringify({ type: "error", error: `no active Claude session in ${d.target} (running: ${cmd})` }));
        return;
      }
    } catch { /* pane check failed, proceed anyway */ }
  }
  sendKeys(d.target, d.text)
    .then(() => {
      ws.send(JSON.stringify({ type: "sent", ok: true, target: d.target, text: d.text }));
      setTimeout(() => engine.pushCapture(ws), 300);
    })
    .catch(e => {
      const msg = e instanceof Error ? e.message : String(e);
      ws.send(JSON.stringify({ type: "error", error: msg }));
    });
};

const sleep: Handler = (ws, data) => {
  const d = data as { target: string };
  runAction(ws, "sleep", d.target, () => sendKeys(d.target, "\x03"));
};

const stop: Handler = (ws, data) => {
  const d = data as { target: string };
  runAction(ws, "stop", d.target, () => tmux.killWindow(d.target));
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
  const d = data as { target?: string; command?: string; cwd?: string };
  const cmd = buildSpawnCmd(d);
  runAction(ws, "wake", d.target, () => sendKeys(d.target, cmd + "\r"));
};

const restart: Handler = (ws, data) => {
  const d = data as { target?: string; command?: string; cwd?: string };
  const cmd = buildSpawnCmd(d);
  runAction(ws, "restart", d.target, async () => {
    await sendKeys(d.target, "\x03"); // Ctrl+C
    await new Promise(r => setTimeout(r, 2000));
    await sendKeys(d.target, "\x03"); // Ctrl+C again (in case first was caught)
    await new Promise(r => setTimeout(r, 500));
    await sendKeys(d.target, cmd + "\r");
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
