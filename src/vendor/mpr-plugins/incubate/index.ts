import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { cmdIncubate, resolveMode } from "./impl";
import { parseFlags } from "maw-js/cli/parse-args";

export const command = {
  name: "incubate",
  description: "Bud + wake + fire /incubate <source> — yeast-budding plus wrapping a source repo.",
};

const USAGE =
  "usage: maw incubate <source-repo> [--stem <name>] [--from <oracle>] [--root] [--seed] [--org <org>] [--note <text>] [--nickname <pretty>] [--fast] [--split] [--dry-run] [--flash | --contribute] [--no-trigger] [--trigger <text>]";

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
          // Plugin-specific
          "--stem": String,
          "--trigger": String,
          "--no-trigger": Boolean,
          "--flash": Boolean,
          "--contribute": Boolean,
          // Bud passthrough
          "--from": String,
          "--from-repo": String,
          "--org": String,
          "--issue": Number,
          "--note": String,
          "--nickname": String,
          "--fast": Boolean,
          "--root": Boolean,
          "--blank": Boolean,
          "--seed": Boolean,
          "--split": Boolean,
          "--dry-run": Boolean,
          "--signal-on-birth": Boolean,
          "--force": Boolean,
          "--track-vault": Boolean,
          "--sync-peers": Boolean,
        },
        0,
      );

      const source = flags._[0];
      if (!source || source === "--help" || source === "-h") {
        return { ok: false, error: USAGE };
      }
      if (source.startsWith("-")) {
        return {
          ok: false,
          error: `"${source}" looks like a flag, not a source repo.\n  ${USAGE}`,
        };
      }

      let mode;
      try {
        mode = resolveMode(!!flags["--flash"], !!flags["--contribute"]);
      } catch (e: any) {
        return { ok: false, error: e.message };
      }

      await cmdIncubate({
        source,
        stem: flags["--stem"],
        mode,
        trigger: flags["--trigger"],
        noTrigger: flags["--no-trigger"],
        // bud passthrough
        from: flags["--from"],
        org: flags["--org"],
        issue: flags["--issue"],
        note: flags["--note"],
        nickname: flags["--nickname"],
        fast: flags["--fast"],
        root: flags["--root"],
        blank: flags["--blank"],
        seed: flags["--seed"],
        split: flags["--split"],
        dryRun: flags["--dry-run"],
        signalOnBirth: flags["--signal-on-birth"],
      });
    } else if (ctx.source === "api") {
      const body = ctx.args as Record<string, unknown>;
      const source = body.source as string | undefined;
      if (!source) return { ok: false, error: "source required" };
      const mode = (body.mode as string | undefined) ?? "default";
      if (!["default", "flash", "contribute"].includes(mode)) {
        return { ok: false, error: `invalid mode: ${mode}` };
      }
      await cmdIncubate({
        source,
        stem: body.stem as string | undefined,
        mode: mode as any,
        trigger: body.trigger as string | undefined,
        noTrigger: body.noTrigger as boolean | undefined,
        from: body.from as string | undefined,
        org: body.org as string | undefined,
        issue: body.issue as number | undefined,
        note: body.note as string | undefined,
        nickname: body.nickname as string | undefined,
        fast: body.fast as boolean | undefined,
        root: body.root as boolean | undefined,
        blank: body.blank as boolean | undefined,
        seed: body.seed as boolean | undefined,
        split: body.split as boolean | undefined,
        dryRun: body.dryRun as boolean | undefined,
        signalOnBirth: body.signalOnBirth as boolean | undefined,
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
