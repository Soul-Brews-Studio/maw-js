import type { InvokeContext, InvokeResult } from "maw-js/sdk";
import { cmdCosts } from "./impl";

export const command = {
  name: "costs",
  description: "Show token usage and estimated cost breakdown per agent.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: any[]) => logs.push(a.map(String).join(" "));
  try {
    await cmdCosts();
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: e.message };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
