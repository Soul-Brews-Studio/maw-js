import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdList } from "maw-js/commands/shared/comm";
import { activeDurationArg, cmdTmuxLs, parseActiveDurationSeconds } from "maw-js/commands/plugins/tmux/impl";
import { parseFlags } from "maw-js/cli/parse-args";

export const command = { name: "ls", description: "List live sessions locally by default; use --federation for peers." };

const HELP = [
  "maw ls — list live sessions (local or cross-node)",
  "",
  "Usage:",
  "  maw ls                  list live local sessions (default)",
  "  maw ls <filter>         filter local sessions",
  "  maw ls --federation     list local + peer sessions",
  "  maw ls --federation <peer>  drill into one peer",
  "  maw ls --federation --node <node>  filter the federated view",
  "  maw ls --json           emit JSON",
  "  maw ls --active [30m]   local sessions touched within a recent threshold",
  "  maw ls --verify         include worktree-bind diagnostics",
  "  maw ls --fix            prune orphaned worktrees (local only)",
  "",
  "Peer aliases are resolved from the maw state peers store (see: maw peers list).",
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
    // Plugin API surface (#1870): peers call GET /api/ls to fetch THIS node's
    // local sessions only. Federation fan-out happens in the CLI caller to
    // avoid recursive peer storms.
    if (ctx.source === "api") {
      const query = ctx.args && !Array.isArray(ctx.args) ? ctx.args as Record<string, unknown> : {};
      const { localLsPayload } = await import("./internal/peer-call");
      const payload = await localLsPayload({
        active: boolish(query.active),
        activeThresholdSec: numberish(query.activeThresholdSec),
        filter: typeof query.node === "string" ? query.node : undefined,
      });
      // API callers need structured data, not ANSI CLI presentation or an
      // InvokeResult.output string wrapper (#1874).
      return { ok: true, ...payload } as InvokeResult;
    }

    if (ctx.source !== "cli") {
      await cmdList();
      return { ok: true, output: logs.join("\n") || undefined };
    }

    const args = (ctx.args as string[]) ?? [];
    const flags = parseFlags(args, {
      "--all": Boolean,
      "--federation": Boolean,
      "--json": Boolean,
      "--active": Boolean,
      "--node": String,
      "--verify": Boolean,
      "--fix": Boolean,
      "--help": Boolean,
      "-h": "--help",
    }, 0);

    if (flags["--help"]) {
      return { ok: true, output: HELP };
    }

    const activeArg = activeDurationArg(args);
    const positionals = flags._ as string[];
    const nodeFilter = typeof flags["--node"] === "string" ? flags["--node"].trim() : "";
    const localFilter = nodeFilter || positionals.find((arg) => arg !== activeArg);
    const positional = positionals[0];
    const json = Boolean(flags["--json"]);

    if (!flags["--federation"] && flags["--active"]) {
      const lsOpts: Parameters<typeof cmdTmuxLs>[0] = {
        all: true,
        compact: true,
        json,
        active: true,
        activeThresholdSec: parseActiveDurationSeconds(activeArg),
        oracleOnly: true,
      };
      if (localFilter) lsOpts.filter = localFilter;
      await cmdTmuxLs(lsOpts);
      return { ok: true, output: logs.join("\n") || undefined };
    }

    // Cross-node: explicit peer alias. Resolves via the maw state peers store — if
    // the positional doesn't match a known peer, surface a clear "unknown
    // peer alias" error rather than silently falling through to local ls
    // (which would be confusing — "I asked for oracle-world, why am I
    // seeing my own sessions?").
    if (flags["--federation"] && positional) {
      const { lsPeer } = await import("./internal/peer-call");
      return await lsPeer(positional, { json });
    }

    if (flags["--federation"] && !flags["--fix"] && !flags["--verify"]) {
      const { lsFederated } = await import("./internal/peer-call");
      return await lsFederated({
        json,
        node: nodeFilter || undefined,
        active: Boolean(flags["--active"]),
        activeThresholdSec: parseActiveDurationSeconds(activeArg),
      });
    }

    // Default/local-only sessions (fast path, no network).
    await cmdList({ fix: Boolean(flags["--fix"]), verify: Boolean(flags["--verify"]) });
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

function boolish(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return false;
}

function numberish(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
