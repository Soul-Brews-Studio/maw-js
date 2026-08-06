import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdReply, cmdReplyList } from "./impl";

export const command = { name: "reply", description: "Reply to a request-reply message." };

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

    if (args[0] === "--list" || args[0] === "-l") {
      await cmdReplyList(args[1]);
      return { ok: true, output: logs.join("\n") || undefined };
    }

    if (!args[0] || args.length < 2) {
      throw new Error("usage: maw reply <correlationId> <message>\n       maw reply --list [oracle]");
    }

    await cmdReply(args[0], args.slice(1).join(" "));
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
