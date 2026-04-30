import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdHeyGale, parseHeyGaleArgs } from "./impl";

export const command = {
  name: "hey-gale",
  description: "Shortcut to message Gale Oracle.",
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
      opts = parseHeyGaleArgs(ctx.args as string[]);
    } else {
      const a = ctx.args as Record<string, unknown>;
      const message = typeof a.message === "string" ? a.message : "";
      const wait = Boolean(a.wait);
      opts = { message, wait };
    }

    await cmdHeyGale(opts);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
