import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdWhoami } from "./impl";

export const command = { name: "whoami", description: "Print session + window + pane address. --short for legacy #S only, --json for machine-readable." };

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
    const argv = (_ctx.source === "cli" ? (_ctx.args as string[]) : []) ?? [];
    await cmdWhoami(argv);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog; console.error = origError;
  }
}
