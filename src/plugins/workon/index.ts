import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { parseFlags } from "maw-js/cli/parse-args";
import { cmdWorkon } from "./impl";

export const command = {
  name: "workon",
  description: "Start working on a repo with optional task context.",
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
    const flags = parseFlags(args, { "--layout": String }, 0);
    if (!flags._[0]) {
      throw new Error("usage: maw workon <repo> [task] [--layout nested|legacy]");
    }
    const layout = flags["--layout"] as string | undefined;
    if (layout && layout !== "nested" && layout !== "legacy") {
      throw new Error("workon: --layout must be nested or legacy");
    }
    await cmdWorkon(flags._[0], flags._[1], { layout: layout as "nested" | "legacy" | undefined });
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
