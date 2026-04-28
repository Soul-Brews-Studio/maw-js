import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdSend, parseSendArgs } from "./impl";

export const command = {
  name: "send",
  description: "Type raw text into a tmux pane (no Enter, composable).",
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
    let opts;
    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      opts = parseSendArgs(args);
    } else {
      const a = ctx.args as Record<string, unknown>;
      const target = (a.target as string) ?? "";
      const text = (a.text as string) ?? "";
      opts = { target, text };
    }

    await cmdSend(opts);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
