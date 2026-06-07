import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdTalkTo } from "./impl";

export const command = { name: "talk-to", description: "Talk to a remote agent on another node." };

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
    const force = args.includes("--force");
    const filtered = args.filter(a => a !== "--force");
    if (!filtered[0] || filtered.length < 2) throw new Error("usage: maw talk-to <agent> <message> [--force]");
    await cmdTalkTo(filtered[0], filtered.slice(1).join(" "), force);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
