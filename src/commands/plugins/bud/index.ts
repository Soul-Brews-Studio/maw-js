import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdBud } from "./impl";
import { parseFlags } from "../../../cli/parse-args";

export const command = {
  name: "bud",
  description: "Create a new oracle (bud from parent)",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: any[]) => logs.push(a.map(String).join(" "));
  try {
    if (ctx.source === "cli") {
      const args = ctx.args as string[];
      const flags = parseFlags(args, {
        "--from": String,
        "--org": String,
        "--repo": String,
        "--issue": Number,
        "--note": String,
        "--fast": Boolean,
        "--root": Boolean,
        "--dry-run": Boolean,
        "--split": Boolean,
        "--blank": Boolean,
      }, 0);

      const name = flags._[0];
      if (!name || name === "--help" || name === "-h") {
        return { ok: false, error: "usage: maw bud <name> [--from <oracle>] [--root] [--blank] [--org <org>] [--repo org/repo] [--issue N] [--note <text>] [--fast] [--split] [--dry-run]" };
      }
      if (name.startsWith("-")) {
        return { ok: false, error: `"${name}" looks like a flag, not an oracle name.\n  usage: maw bud <name> ${args.join(" ")}` };
      }

      await cmdBud(name, {
        from: flags["--from"],
        repo: flags["--repo"],
        org: flags["--org"],
        issue: flags["--issue"],
        note: flags["--note"],
        fast: flags["--fast"],
        root: flags["--root"],
        dryRun: flags["--dry-run"],
        split: flags["--split"],
        blank: flags["--blank"],
      });
    } else if (ctx.source === "api") {
      const body = ctx.args as Record<string, unknown>;
      const name = body.name as string;
      if (!name) return { ok: false, error: "name required" };
      await cmdBud(name, {
        from: body.from as string | undefined,
        repo: body.repo as string | undefined,
        org: body.org as string | undefined,
        issue: body.issue as number | undefined,
        note: body.note as string | undefined,
        fast: body.fast as boolean | undefined,
        root: body.root as boolean | undefined,
        dryRun: body.dryRun as boolean | undefined,
        split: body.split as boolean | undefined,
        blank: body.blank as boolean | undefined,
      });
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
