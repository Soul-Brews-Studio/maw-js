import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdDoctor } from "./impl";

export const command = {
  name: "doctor",
  description: "Diagnostic checks — verifies maw install health and auto-heals when possible.",
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
    let args: string[] = [];
    if (ctx.source === "cli") {
      args = ctx.args as string[];
    } else {
      const a = ctx.args as Record<string, unknown>;
      if (typeof a.check === "string") args = [a.check];
    }
    const result = await cmdDoctor(args);
    return {
      ok: result.ok,
      output: logs.join("\n") || undefined,
      error: result.ok ? undefined : "one or more checks failed",
    };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
