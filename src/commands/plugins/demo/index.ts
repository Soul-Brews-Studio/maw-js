import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdDemo } from "./impl";
import { parseFlags } from "../../../cli/parse-args";

export const command = {
  name: "demo",
  description: "Run a simulated multi-agent session. No API key required.",
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
    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      const flags = parseFlags(args, {
        "--fast": Boolean,
        "--help": Boolean,
        "-h": "--help",
      }, 0);

      if (flags["--help"]) {
        return {
          ok: true,
          output: [
            "maw demo — simulated multi-agent session",
            "",
            "Usage: maw demo [--fast]",
            "",
            "Spawns two mock agents in tmux panes, streams scripted output with",
            "realistic pauses, then shows $0.00 cost. No API key required.",
            "",
            "Flags:",
            "  --fast   Skip sleep delays (CI / screenshot mode)",
            "  --help   Show this message",
            "",
            "Requires an active tmux session.",
            "  Run: tmux new-session -s demo",
            "  Then: maw demo",
          ].join("\n"),
        };
      }

      await cmdDemo({ fast: !!flags["--fast"] });
    } else {
      // API / peer: best-effort, non-interactive
      const body = ctx.args as Record<string, unknown>;
      await cmdDemo({ fast: !!body.fast, sleep: async () => {} });
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return {
      ok: false,
      error: e.message ?? String(e),
      output: logs.join("\n") || undefined,
    };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
