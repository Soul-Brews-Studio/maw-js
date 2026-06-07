import type { InvokeContext, InvokeResult } from "maw-js/sdk";
import { cmdForwardError, parseForwardErrorArgs } from "./impl";

export const command = {
  name: "forward-error",
  description: "Forward the current tmux pane's recent error context to a doctor oracle.",
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
    const opts = ctx.source === "cli"
      ? parseForwardErrorArgs(ctx.args as string[])
      : {
          target: (ctx.args as Record<string, unknown>).target as string | undefined,
          last: (ctx.args as Record<string, unknown>).last as number | undefined,
        };
    await cmdForwardError(opts);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
