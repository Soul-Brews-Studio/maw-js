import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdList } from "maw-js/commands/shared/comm";
import { parseFlags } from "maw-js/cli/parse-args";

export const command = { name: "ls", description: "List live sessions and agents; use maw fleet ls for registered fleet config." };

const HELP = [
  "maw ls — list live sessions (local or cross-node)",
  "",
  "Usage:",
  "  maw ls                  list live local sessions (default)",
  "  maw ls <peer>           list sessions on a federation peer",
  "  maw ls --all            aggregate sessions from all known peers",
  "  maw ls --json           emit JSON (combine with <peer> or --all)",
  "  maw ls --fix            prune orphaned worktrees (local only)",
  "",
  "Peer aliases are resolved from ~/.maw/peers.json (see: maw peers list).",
  "For registered fleet config, use maw fleet ls.",
].join("\n");

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  // Stream-style output capture: any console.log/error inside cmdList is
  // funneled to ctx.writer (live UI) or aggregated for InvokeResult.output.
  // Kept identical to the pre-1.1.0 shape so local `maw ls` behavior is
  // byte-for-byte unchanged.
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
    // API source (non-CLI) — preserve original behavior. The /api/sessions
    // endpoint already exposes cross-node listing at the HTTP layer, so
    // there is no need to plumb peer aliasing through this entrypoint too.
    if (ctx.source !== "cli") {
      await cmdList();
      return { ok: true, output: logs.join("\n") || undefined };
    }

    const args = (ctx.args as string[]) ?? [];
    const flags = parseFlags(args, {
      "--all": Boolean,
      "--json": Boolean,
      "--fix": Boolean,
      "--help": Boolean,
      "-h": "--help",
    }, 0);

    if (flags["--help"]) {
      return { ok: true, output: HELP };
    }

    const positional = flags._[0];
    const json = Boolean(flags["--json"]);

    // Cross-node: explicit peer alias. Resolves via ~/.maw/peers.json — if
    // the positional doesn't match a known peer, surface a clear "unknown
    // peer alias" error rather than silently falling through to local ls
    // (which would be confusing — "I asked for oracle-world, why am I
    // seeing my own sessions?").
    if (positional) {
      const { lsPeer } = await import("./internal/peer-call");
      return await lsPeer(positional, { json });
    }

    // Cross-node: aggregate every alias in ~/.maw/peers.json.
    if (flags["--all"]) {
      const { lsAllPeers } = await import("./internal/peer-call");
      return await lsAllPeers({ json });
    }

    // Default: local sessions (existing behavior, including --fix).
    await cmdList({ fix: Boolean(flags["--fix"]) });
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
