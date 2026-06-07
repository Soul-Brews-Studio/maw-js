import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";

export const command = {
  name: "soul-sync",
  description: "Synchronize oracle soul across nodes.",
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

    if (args.includes("--project")) {
      const { cmdSoulSyncProject } = await import("./impl");
      await cmdSoulSyncProject();
    } else {
      const { cmdSoulSync } = await import("./impl");
      const fromIdx = args.indexOf("--from");
      if (fromIdx !== -1) {
        await cmdSoulSync(args[fromIdx + 1], { from: true });
      } else {
        await cmdSoulSync(args[0]);
      }
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
