import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdTransportStatus } from "../../shared/transport";

export const command = {
  name: ["transport", "tp"],
  description: "Transport layer status and diagnostics",
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
    let sub: string;
    if (ctx.source === "cli") {
      sub = (ctx.args as string[])[0] ?? "status";
    } else {
      sub = ((ctx.args as Record<string, unknown>).sub as string) ?? "status";
    }

    if (!sub || sub === "status") {
      await cmdTransportStatus();
    } else {
      logs.push("usage: maw transport [status]");
      return { ok: false, error: `unknown subcommand: ${sub}` };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
