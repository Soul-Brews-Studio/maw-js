import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdDone } from "../../done";

export const command = {
  name: ["done", "finish"],
  description: "Clean up a finished worktree window: rrr, git save, kill, remove worktree.",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: any[]) => logs.push(a.map(String).join(" "));
  try {
    let name: string;
    let force: boolean | undefined;
    let dryRun: boolean | undefined;

    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      // Find first non-flag arg
      const positional = args.filter(a => !a.startsWith("--"));
      if (!positional[0]) {
        return { ok: false, error: "usage: maw done <window-name> [--force] [--dry-run]" };
      }
      name = positional[0];
      force = args.includes("--force");
      dryRun = args.includes("--dry-run");
    } else {
      const args = ctx.args as Record<string, unknown>;
      if (!args.name) {
        return { ok: false, error: "name is required" };
      }
      name = args.name as string;
      force = args.force as boolean | undefined;
      dryRun = args.dryRun as boolean | undefined;
    }

    await cmdDone(name, { force, dryRun });
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
