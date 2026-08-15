import type { InvokeContext, InvokeResult } from "maw-js/sdk";
import { cmdPing } from "./impl";

export const command = {
  name: "ping",
  description: "Ping peer nodes to check connectivity and auth status.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: any[]) => logs.push(a.map(String).join(" "));
  try {
    let node: string | undefined;
    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      node = args[0];
    } else {
      const args = ctx.args as Record<string, unknown>;
      node = args.node as string | undefined;
    }
    await cmdPing(node);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: e.message };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
