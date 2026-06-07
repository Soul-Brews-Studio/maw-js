import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { parseFlags } from "maw-js/cli/parse-args";
import { cmdAttach } from "./impl";

export const command = {
  name: "attach",
  description: "Smart attach — local live or sleeping-fleet wake (#25 Phase 1, local only).",
};

const USAGE = "usage: maw attach <name> [--shell [--split|--no-split]] [--dry-run] [-y|--yes]";

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
      const flags = parseFlags(
        args,
        {
          "--dry-run": Boolean,
          "--yes": Boolean,
          "-y": "--yes",
          "--shell": Boolean,
          "--split": Boolean,
          "--no-split": Boolean,
        },
        0,
      );
      const name = flags._[0];
      if (!name || name === "--help" || name === "-h") {
        return { ok: false, error: USAGE };
      }
      if (name.startsWith("-")) {
        return { ok: false, error: `"${name}" looks like a flag, not an oracle name.\n  ${USAGE}` };
      }
      await cmdAttach(name, {
        dryRun: flags["--dry-run"],
        yes: flags["--yes"],
        shell: flags["--shell"],
        split: flags["--shell"] ? !flags["--no-split"] : flags["--split"],
      });
    } else if (ctx.source === "api") {
      const body = ctx.args as Record<string, unknown>;
      const name = body.name as string;
      if (!name) return { ok: false, error: "name required" };
      await cmdAttach(name, {
        dryRun: body.dryRun as boolean | undefined,
        yes: true,
      });
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
