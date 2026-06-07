import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdZoom } from "./impl";
import { parseFlags } from "maw-js/cli/parse-args";

export const command = {
  name: "zoom",
  description: "Toggle tmux pane zoom (full-screen).",
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
    let target: string;
    let opts: { pane?: number } = {};

    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      const flags = parseFlags(args, { "--pane": Number }, 0);

      target = flags._[0];
      if (!target || target === "--help" || target === "-h") {
        return { ok: false, error: "usage: maw zoom <target> [--pane N]" };
      }
      if (target.startsWith("-")) {
        return { ok: false, error: `"${target}" looks like a flag, not a target.\n  usage: maw zoom <target>` };
      }
      opts = { pane: flags["--pane"] };
    } else {
      const body = ctx.args as Record<string, unknown>;
      if (!body.target) return { ok: false, error: "target is required" };
      target = body.target as string;
      opts = { pane: body.pane as number | undefined };
    }

    await cmdZoom(target, opts);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
