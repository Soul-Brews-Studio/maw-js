import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdSendEnter, parseSendEnterArgs } from "./impl";

export const command = {
  name: "send-enter",
  description: "Send Enter key to a maw target — manually submit pending input on stuck panes.",
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
      opts = parseSendEnterArgs(args);
    } else {
      const a = ctx.args as Record<string, unknown>;
      const target = (a.target as string) ?? "";
      const count = typeof a.N === "number" ? (a.N as number) : typeof a.count === "number" ? (a.count as number) : 1;
      opts = { target, count };
    }

    await cmdSendEnter(opts);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
