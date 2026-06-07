import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdSleepOne } from "./impl";

export const command = {
  name: ["sleep"],
  description: "Gracefully stop one Oracle window; use kill for immediate tmux removal or done for worktree cleanup.",
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
    let oracle: string;
    let window: string | undefined;

    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      if (!args[0]) {
        return { ok: false, error: "usage: maw sleep <oracle> [window]  (see: maw kill for immediate removal, maw done for worktrees)" };
      }
      if (args[0] === "--all-done") {
        logs.push("(placeholder) maw sleep --all-done — sleep ALL agents. Not yet implemented.");
        return { ok: true, output: logs.join("\n") };
      }
      oracle = args[0];
      window = args[1];
    } else {
      const args = ctx.args as Record<string, unknown>;
      if (!args.oracle) {
        return { ok: false, error: "oracle is required (usage: maw sleep <oracle> [window])" };
      }
      oracle = args.oracle as string;
      window = args.window as string | undefined;
    }

    await cmdSleepOne(oracle, window);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
