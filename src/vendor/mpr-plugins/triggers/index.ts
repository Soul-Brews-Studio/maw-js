import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";

export const command = {
  name: "triggers",
  description: "List configured event triggers.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const { cmdTriggers } = await import("maw-js/commands/shared/triggers");

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
    await cmdTriggers();
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
