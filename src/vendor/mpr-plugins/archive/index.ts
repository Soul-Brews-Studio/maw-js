import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdArchive } from "./impl";

export const command = {
  name: "archive",
  description: "Archive an oracle's tmux session and data.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const args = ctx.source === "cli" ? (ctx.args as string[]) : [];

  // Handle --help before monkey-patching so output always reaches stdout
  if (args[0] === "--help" || args[0] === "-h") {
    const help = "usage: maw archive <oracle> [--dry-run] — archive an oracle's tmux session and data";
    if (ctx.writer) ctx.writer(help);
    else console.log(help);
    return { ok: true };
  }

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
    if (!args[0]) throw new Error("usage: maw archive <oracle> [--dry-run]");
    await cmdArchive(args[0], { dryRun: args.includes("--dry-run") });
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
