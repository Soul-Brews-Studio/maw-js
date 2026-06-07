import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdAwaken } from "./impl";
import { parseFlags } from "maw-js/cli/parse-args";

export const command = {
  name: "awaken",
  description: "Bud + wake + fire /awaken — yeast-budding plus awakening ritual.",
};

const USAGE =
  "usage: maw awaken <name> [--from <oracle>] [--root] [--seed] [--org <org>] [--repo org/repo] [--issue N] [--note <text>] [--nickname <pretty>] [--fast] [--split] [--dry-run] [--trigger <text>] [--no-trigger] [-y|--yes]";

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
          "--from": String,
          "--from-repo": String,
          "--stem": String,
          "--org": String,
          "--repo": String,
          "--issue": Number,
          "--note": String,
          "--nickname": String,
          "--trigger": String,
          "--no-trigger": Boolean,
          "--fast": Boolean,
          "--root": Boolean,
          "--blank": Boolean,
          "--pr": Boolean,
          "--split": Boolean,
          "--seed": Boolean,
          "--dry-run": Boolean,
          "--signal-on-birth": Boolean,
          "--force": Boolean,
          "--track-vault": Boolean,
          "--sync-peers": Boolean,
          "--yes": Boolean,
          "-y": "--yes",
        },
        0,
      );

      const name = flags._[0];
      if (!name || name === "--help" || name === "-h") {
        return { ok: false, error: USAGE };
      }
      if (name.startsWith("-")) {
        return {
          ok: false,
          error: `"${name}" looks like a flag, not an oracle name.\n  ${USAGE}`,
        };
      }

      await cmdAwaken(name, {
        from: flags["--from"],
        repo: flags["--repo"],
        org: flags["--org"],
        issue: flags["--issue"],
        note: flags["--note"],
        nickname: flags["--nickname"],
        trigger: flags["--trigger"],
        noTrigger: flags["--no-trigger"],
        fast: flags["--fast"],
        root: flags["--root"],
        dryRun: flags["--dry-run"],
        split: flags["--split"],
        seed: flags["--seed"],
        blank: flags["--blank"],
        signalOnBirth: flags["--signal-on-birth"],
        yes: flags["--yes"],
      });
    } else if (ctx.source === "api") {
      const body = ctx.args as Record<string, unknown>;
      const name = body.name as string;
      if (!name) return { ok: false, error: "name required" };
      await cmdAwaken(name, {
        from: body.from as string | undefined,
        repo: body.repo as string | undefined,
        org: body.org as string | undefined,
        issue: body.issue as number | undefined,
        note: body.note as string | undefined,
        nickname: body.nickname as string | undefined,
        trigger: body.trigger as string | undefined,
        noTrigger: body.noTrigger as boolean | undefined,
        fast: body.fast as boolean | undefined,
        root: body.root as boolean | undefined,
        dryRun: body.dryRun as boolean | undefined,
        split: body.split as boolean | undefined,
        seed: body.seed as boolean | undefined,
        blank: body.blank as boolean | undefined,
        signalOnBirth: body.signalOnBirth as boolean | undefined,
        // API/HTTP path has no TTY by definition, but pass through for parity.
        yes: (body.yes as boolean | undefined) ?? true,
      });
    }

    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return {
      ok: false,
      error: logs.join("\n") || e.message,
      output: logs.join("\n") || undefined,
    };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
