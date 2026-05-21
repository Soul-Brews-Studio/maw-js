import type { InvokeContext, InvokeResult } from "../../../plugin/types";

export const command = {
  name: "federation",
  description: "Multi-node federation status and sync.",
};

function readOption(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

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
    const args = ctx.source === "cli" ? (ctx.args as string[]) : [];
    const sub = args[0]?.toLowerCase();
    const { parsePeerSourceMode } = await import("../../shared/peer-sources");
    const peerSourceRaw = readOption(args, "--peers");
    const peerSource = parsePeerSourceMode(peerSourceRaw, sub === "sync" ? "config" : "both");
    if (!peerSource) {
      return { ok: false, error: "usage: --peers config|scout|both" };
    }

    if (sub === "--help" || sub === "-h" || sub === "help") {
      return {
        ok: false,
        error: "usage: maw federation <status|sync> [--verify|--dry-run|--check|--prune|--force|--json|--peers config|scout|both]",
      };
    }

    if (!sub || sub === "status" || sub === "ls" || sub.startsWith("--")) {
      if (args.includes("--verify")) {
        const { cmdFederationStatusVerify } = await import("../../shared/federation");
        const res = await cmdFederationStatusVerify();
        if (!res.ok) {
          return { ok: false, error: "one or more pairs are non-healthy", output: logs.join("\n") || undefined };
        }
      } else {
        const { cmdFederationStatus } = await import("../../shared/federation");
        await cmdFederationStatus({ peerSourceMode: peerSource });
      }
    } else if (sub === "sync") {
      const { cmdFederationSync } = await import("../../shared/federation-sync");
      await cmdFederationSync({
        dryRun: args.includes("--dry-run"),
        check: args.includes("--check"),
        prune: args.includes("--prune"),
        force: args.includes("--force"),
        json: args.includes("--json"),
        peers: peerSource,
      });
    } else {
      return {
        ok: false,
        error: "usage: maw federation <status|sync> [--verify|--dry-run|--check|--prune|--force|--json|--peers config|scout|both]",
      };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
