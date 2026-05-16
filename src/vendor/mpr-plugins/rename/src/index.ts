import type { InvokeContext, InvokeResult } from "@maw-js/sdk/plugin";
import { cmdRename } from "./impl";

export const command = {
  name: "rename",
  description: "Rename tmux tabs/windows with Oracle-prefix auto-formatting; use tab to list or message tabs.",
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
    if (!args[0] || !args[1]) {
      throw new Error("usage: maw rename <tab# or name> <new-name>  (see: maw tab to list tabs)");
    }
    await cmdRename(args[0], args[1]);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
