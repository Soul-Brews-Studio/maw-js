import type { InvokeContext, InvokeResult } from "../../../plugin/types";

export const command = {
  name: "federation",
  description: "Multi-node federation status and sync.",
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
        const { cmdFederationStatus } = await import("../../shared/federation");
        await cmdFederationStatus();
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
    } else {
      return {
        ok: false,
        error: "usage: maw federation <status|sync> [--verify|--dry-run|--check|--prune|--force|--json]",
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
