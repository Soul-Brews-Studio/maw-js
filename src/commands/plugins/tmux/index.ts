import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { parseFlags } from "../../../cli/parse-args";
import { cmdTmuxPeek } from "./impl";

export const command = {
  name: "tmux",
  description: "tmux control verbs — peek.",
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
    const sub = args[0]?.toLowerCase();

    if (sub === "peek") {
      const flags = parseFlags(args, {
        "--lines": Number,
        "--history": Boolean,
        "--help": Boolean,
        "-h": "--help",
      }, 1);
      if (flags["--help"]) {
        console.log("usage: maw tmux peek <target> [--lines N] [--history]");
        console.log("  target: pane id (%N), session:w.p, team-agent name, or session name");
        return { ok: true, output: logs.join("\n") || undefined };
      }
      const target = flags._[0];
      if (!target) {
        console.log("usage: maw tmux peek <target> [--lines N] [--history]");
        return { ok: false, error: "target required", output: logs.join("\n") };
      }
      const lines = (flags["--lines"] as number | undefined) ?? 30;
      const history = !!flags["--history"];
      await cmdTmuxPeek(target, { lines, history });
    } else if (!sub || sub === "--help" || sub === "-h") {
      console.log("usage: maw tmux <peek> [args]");
      console.log("  peek <target>   read content of a tmux pane");
      return { ok: true, output: logs.join("\n") || undefined };
    } else {
      console.log(`unknown tmux subcommand: ${sub}`);
      console.log("usage: maw tmux <peek>");
      return { ok: false, error: `unknown subcommand: ${sub}`, output: logs.join("\n") };
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
