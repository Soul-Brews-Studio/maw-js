import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdLocate } from "./impl";
import { parseFlags } from "maw-js/cli/parse-args";

export const command = {
  name: "locate",
  description: "Locate an oracle — repo path, session, fleet config, federation node.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const args = ctx.args ?? [];
  const flags = parseFlags(args, {
    "--path": Boolean,
    "-p": "--path",
    "--json": Boolean,
  }, 0);

  const oracle = flags._[0];

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
    await cmdLocate(oracle, {
      path: flags["--path"],
      json: flags["--json"],
    });
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: logs.join("\n") || msg, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
