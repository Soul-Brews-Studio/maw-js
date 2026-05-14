import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { parseFlags } from "../../../cli/parse-args";

export const command = {
  name: "federation",
  description: "Multi-node federation status and sync.",
};

/**
 * Expand bundled POSIX short flags (e.g. `-av` → `-a -v`) so `arg()` can parse
 * them. Only splits tokens that look like pure short-flag bundles (matching
 * `/^-[a-zA-Z]{2,}$/`). Long flags (`--all`) and `--` end-of-options are left
 * untouched. Kept local to this dispatcher since `arg` does not natively bundle.
 */
function expandShortBundles(args: string[]): string[] {
  const out: string[] = [];
  let seenDoubleDash = false;
  for (const a of args) {
    if (seenDoubleDash) { out.push(a); continue; }
    if (a === "--") { seenDoubleDash = true; out.push(a); continue; }
    if (/^-[a-zA-Z]{2,}$/.test(a)) {
      for (const ch of a.slice(1)) out.push(`-${ch}`);
    } else {
      out.push(a);
    }
  }
  return out;
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push((a as unknown[]).map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    if (ctx.writer) ctx.writer(...a);
    else logs.push((a as unknown[]).map(String).join(" "));
  };

  try {
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === "status" || sub === "ls") {
      if (args.includes("--verify")) {
        const { cmdFederationStatusVerify } = await import("../../shared/federation");
        const res = await cmdFederationStatusVerify();
        if (!res.ok) {
          return { ok: false, error: "one or more pairs are non-healthy", output: logs.join("\n") || undefined };
        }
      } else {
        // Parse `-a` / `--all` / `-v` / `--verbose` for federation ls/status (#1329).
        // Default (no flags) MUST be byte-for-byte unchanged — see verify in PR.
        const skip = sub === "status" || sub === "ls" ? 1 : 0;
        const flags = parseFlags(expandShortBundles(args), {
          "--all": Boolean,
          "-a": "--all",
          "--verbose": Boolean,
          "-v": "--verbose",
        }, skip);
        const { cmdFederationStatus } = await import("../../shared/federation");
        await cmdFederationStatus({
          all: flags["--all"] ?? false,
          verbose: flags["--verbose"] ?? false,
        });
      }
    } else if (sub === "sync") {
      const { cmdFederationSync } = await import("../../shared/federation-sync");
      await cmdFederationSync({
        dryRun: args.includes("--dry-run"),
        check: args.includes("--check"),
        prune: args.includes("--prune"),
        force: args.includes("--force"),
        json: args.includes("--json"),
      });
    } else if (sub === "agents") {
      const { cmdFederationAgents } = await import("../../shared/federation-agents");
      const nodeFlag = args.find(a => a.startsWith("--node="))?.split("=")[1]
        ?? (args.includes("--node") ? args[args.indexOf("--node") + 1] : undefined);
      const oracleFlag = args.find(a => a.startsWith("--oracle="))?.split("=")[1]
        ?? (args.includes("--oracle") ? args[args.indexOf("--oracle") + 1] : undefined);
      await cmdFederationAgents({
        json: args.includes("--json"),
        node: nodeFlag,
        oracle: oracleFlag,
      });
    } else {
      return {
        ok: false,
        error: "usage: maw federation <status|ls|agents|sync> [-a|--all|-v|--verbose|--verify|--json|--node <name>|--oracle <glob>|--dry-run|--check|--prune|--force]",
      };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: logs.join("\n") || msg, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
