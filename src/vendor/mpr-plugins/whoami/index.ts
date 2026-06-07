import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdWhoami } from "./impl";

export const command = { name: "whoami", description: "Print the current tmux session name." };

export default async function handler(_ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log, origError = console.error;
  console.log = (...a: any[]) => {
    if (_ctx.writer) _ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  console.error = (...a: any[]) => {
    if (_ctx.writer) _ctx.writer(...a);
    else logs.push(a.map(String).join(" "));
  };
  try {
    await cmdWhoami();
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog; console.error = origError;
  }
}
