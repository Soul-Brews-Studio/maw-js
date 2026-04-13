import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdTake } from "../../take";

export const command = {
  name: ["take", "handover"],
  description: "Move a tmux window from one oracle session to another (vesicle transport).",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: any[]) => logs.push(a.map(String).join(" "));
  try {
    let source: string;
    let target: string | undefined;

    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      if (!args[0]) {
        return { ok: false, error: "usage: maw take <session>:<window> [target-session]" };
      }
      source = args[0];
      target = args[1];
    } else {
      const args = ctx.args as Record<string, unknown>;
      if (!args.source) {
        return { ok: false, error: "source is required" };
      }
      source = args.source as string;
      target = args.target as string | undefined;
    }

    await cmdTake(source, target);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
