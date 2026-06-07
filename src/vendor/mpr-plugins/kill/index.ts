import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdKill } from "./impl";
import { parseFlags } from "maw-js/cli/parse-args";

export const command = {
  name: "kill",
  description: "Immediately kill a tmux session, window, or pane; use sleep for graceful stop or done for worktrees.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: any[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  try {
    let target: string;
    let opts: { pane?: number } = {};

    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      const flags = parseFlags(args, { "--pane": Number, "--peer": String }, 0);

      target = flags._[0];
      if (!target || target === "--help" || target === "-h") {
        return { ok: false, error: "usage: maw kill <target>[:window] [--pane N] [--peer <alias>]  (see: maw sleep for graceful stop, maw done for worktrees)" };
      }
      if (target.startsWith("-")) {
        return { ok: false, error: `"${target}" looks like a flag, not a target.\n  usage: maw kill <target>  (see: maw sleep for graceful stop, maw done for worktrees)` };
      }

      if (flags["--peer"]) {
        return await forwardToPeer(flags["--peer"], target, flags);
      }

      opts = { pane: flags["--pane"] };
    } else {
      const body = ctx.args as Record<string, unknown>;
      if (!body.target) return { ok: false, error: "target is required" };
      target = body.target as string;
      opts = { pane: body.pane as number | undefined };
    }

    await cmdKill(target, opts);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

/**
 * Forward a `maw kill` CLI invocation to a federation peer's /api/kill
 * endpoint instead of killing a local tmux entity. Mirrors wake's
 * `forwardToPeer()` — see plugins/wake/index.ts:163.
 *
 * Alias lookup goes through the maw state peers store (the same store
 * managed by `maw peers`). Unknown alias surfaces as an `ok: false` plugin error
 * rather than throwing, so the CLI layer prints a clean message. Network
 * + non-2xx responses are mapped the same way.
 *
 * The forwarded body is `{ target, pane? }` — the same shape the API
 * branch of this handler accepts on the peer side.
 */
async function forwardToPeer(
  alias: string,
  target: string,
  flags: Record<string, any>,
): Promise<InvokeResult> {
  const { resolvePeer } = await import("./internal/peer-resolve");
  const peer = resolvePeer(alias);
  if (!peer) return { ok: false, error: `unknown peer alias: ${alias} (see: maw peers list)` };

  const body: Record<string, unknown> = { target };
  if (typeof flags["--pane"] === "number") body.pane = flags["--pane"];

  const { callPeerKill } = await import("./internal/peer-call");
  let res: { ok: boolean; status?: number; data?: any };
  try {
    res = await callPeerKill(peer.url, body);
  } catch (e: any) {
    return { ok: false, error: `peer kill failed (${alias} ${peer.url}): ${e?.message || e}` };
  }

  if (!res?.ok) {
    if (res?.status === 404) {
      return { ok: false, error: `peer ${alias} does not support /api/kill (HTTP 404 at ${peer.url})` };
    }
    const detail = res?.data?.error || (res?.status ? `HTTP ${res.status}` : "no response");
    return { ok: false, error: `peer kill failed (${alias} ${peer.url}): ${detail}` };
  }

  const summary = `\x1b[32m✓\x1b[0m forwarded kill → ${alias} (${peer.url}) — ${target}`;
  const remoteOut = typeof res.data?.output === "string" ? res.data.output : "";
  return { ok: true, output: remoteOut ? `${summary}\n${remoteOut}` : summary };
}
