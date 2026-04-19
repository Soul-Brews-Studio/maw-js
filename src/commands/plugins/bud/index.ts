import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { cmdBud } from "./impl";
import { cmdBudFromRepo, looksLikeUrl } from "./from-repo";
import { parseFlags } from "../../../cli/parse-args";

export const command = {
  name: "bud",
  description: "Create a new oracle (bud from parent)",
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
        "--from": String,
        "--from-repo": String,
        "--stem": String,
        "--org": String,
        "--repo": String,
        "--issue": Number,
        "--note": String,
        "--nickname": String,
        "--fast": Boolean,
        "--root": Boolean,
        "--dry-run": Boolean,
        "--pr": Boolean,
        "--split": Boolean,
        "--seed": Boolean,
        "--blank": Boolean,
        "--signal-on-birth": Boolean,
        "--force": Boolean,
        "--track-vault": Boolean,
        "--sync-peers": Boolean,
      }, 0);

      // --from-repo branches early: inject scaffolding into an existing repo (#588).
      // Scaffold-only this PR — see docs/bud/from-repo-design.md.
      if (flags["--from-repo"]) {
        const target = flags["--from-repo"];
        const stem = flags["--stem"];
        if (!stem) {
          return { ok: false, error: "--from-repo requires --stem <stem> (oracle stem, no -oracle suffix)" };
        }
        if (stem.endsWith("-oracle")) {
          return { ok: false, error: `--stem must NOT end with '-oracle' — got '${stem}'. Try: --stem ${stem.replace(/-oracle$/, "")}` };
        }
        await cmdBudFromRepo({
          target,
          stem,
          isUrl: looksLikeUrl(target),
          pr: !!flags["--pr"],
          dryRun: !!flags["--dry-run"],
          force: !!flags["--force"],
          from: flags["--from"],
          trackVault: !!flags["--track-vault"],
          seed: !!flags["--seed"],
          syncPeers: !!flags["--sync-peers"],
        });
        return { ok: true, output: logs.join("\n") || undefined };
      }

      const name = flags._[0];
      if (!name || name === "--help" || name === "-h") {
        return { ok: false, error: "usage: maw bud <name> [--from <oracle>] [--root] [--seed] [--org <org>] [--repo org/repo] [--issue N] [--note <text>] [--nickname <pretty>] [--fast] [--split] [--dry-run]\n       Or:    maw bud --from-repo <path|url> --stem <stem> [--pr] [--from <parent>] [--seed] [--sync-peers] [--force] [--track-vault] [--dry-run]  (#588)\n       Default: born blank. Use --seed to pre-load parent's ψ at birth.\n       Pull memory later: maw soul-sync <parent> --from" };
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
        nickname: flags["--nickname"],
        fast: flags["--fast"],
        root: flags["--root"],
        dryRun: flags["--dry-run"],
        split: flags["--split"],
        seed: flags["--seed"],
        blank: flags["--blank"],
        signalOnBirth: flags["--signal-on-birth"],
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
        nickname: body.nickname as string | undefined,
        fast: body.fast as boolean | undefined,
        root: body.root as boolean | undefined,
        dryRun: body.dryRun as boolean | undefined,
        split: body.split as boolean | undefined,
        seed: body.seed as boolean | undefined,
        blank: body.blank as boolean | undefined,
        signalOnBirth: body.signalOnBirth as boolean | undefined,
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
