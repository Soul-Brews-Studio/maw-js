import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { parseFlags } from "../../../cli/parse-args";

export const command = {
  name: "wake",
  description: "Spawn or attach to an oracle session",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  // Dynamic imports — clean, one await, mockable
  const { cmdWake } = await import("../../shared/wake");
  const { cmdWakeAll } = await import("../../shared/fleet");
  const { parseWakeTarget, ensureCloned } = await import("../../shared/wake-target");
  const { fetchGitHubPrompt } = await import("../../shared/wake-resolve");

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

      if (!args[0]) {
        return {
          ok: false,
          error: "usage: maw wake <oracle|org/repo|URL> [task] [--task \"<prompt>\"] [--wt <name>] [--fresh] [--attach] [--issue N] [--pr N] [--repo org/name] [--list]\n       maw wake all [--kill]\n       (--new is a deprecated alias for --wt, removed in alpha.114)",
        };
      }

      if (args[0].toLowerCase() === "all") {
        const flags = parseFlags(args, { "--kill": Boolean, "--all": Boolean, "--resume": Boolean }, 1);
        await cmdWakeAll({ kill: flags["--kill"], all: flags["--all"], resume: flags["--resume"] });
        return { ok: true, output: logs.join("\n") || undefined };
      }

      if (args.includes("--new")) {
        console.error("\x1b[33m⚠\x1b[0m --new renamed to --wt (removed in alpha.114)");
      }

      const flags = parseFlags(args, {
        "--wt": String, "--new": "--wt",
        "--incubate": String, "--issue": Number,
        "--pr": Number, "--repo": String, "--task": String,
        "--fresh": Boolean, "--attach": Boolean, "-a": "--attach", "--list": Boolean, "--ls": "--list",
        "--split": Boolean,
      }, 1);

      const wakeOpts: {
        task?: string; wt?: string; prompt?: string;
        incubate?: string; fresh?: boolean; attach?: boolean; listWt?: boolean;
        split?: boolean; urlRepoName?: string;
      } = {};
      let issueNum: number | null = flags["--issue"] ?? null;
      let repo: string | undefined = flags["--repo"];

      const parsed = parseWakeTarget(args[0]);
      const oracleName = parsed ? parsed.oracle : args[0];
      if (parsed) {
        await ensureCloned(parsed.slug);
        if (parsed.issueNum) { issueNum = parsed.issueNum; repo = parsed.slug; }
        // #769 — pass the FULL repo name through so detectSession resolves on
        // the explicit URL intent rather than the stripped sub-token.
        wakeOpts.urlRepoName = parsed.slug.split("/").pop();
      }

      if (flags["--wt"]) wakeOpts.wt = flags["--wt"];
      if (flags["--incubate"]) wakeOpts.incubate = flags["--incubate"];
      if (flags["--fresh"]) wakeOpts.fresh = true;
      if (flags["--attach"]) wakeOpts.attach = true;
      if (flags["--list"]) wakeOpts.listWt = true;
      if (flags["--split"]) wakeOpts.split = true;

      const positionals = flags._;
      if (positionals.length > 0) wakeOpts.task = positionals[0];
      if (positionals.length > 1) wakeOpts.prompt = positionals.slice(1).join(" ");

      if (wakeOpts.incubate && !repo) { repo = wakeOpts.incubate; }
      const prNum: number | null = flags["--pr"] ?? null;
      if (issueNum) {
        console.log(`\x1b[36m⚡\x1b[0m fetching issue #${issueNum}...`);
        wakeOpts.prompt = await fetchGitHubPrompt("issue", issueNum, repo);
        if (!wakeOpts.task) wakeOpts.task = `issue-${issueNum}`;
      } else if (prNum) {
        console.log(`\x1b[36m⚡\x1b[0m fetching PR #${prNum}...`);
        wakeOpts.prompt = await fetchGitHubPrompt("pr", prNum, repo);
        if (!wakeOpts.task) wakeOpts.task = `pr-${prNum}`;
      } else if (flags["--task"]) {
        wakeOpts.prompt = flags["--task"];
      }

      await cmdWake(oracleName, wakeOpts);
      return { ok: true, output: logs.join("\n") || undefined };
    }

    // API source
    const body = ctx.args as Record<string, unknown>;
    const oracle = body.oracle as string | undefined;
    if (!oracle) return { ok: false, error: "missing oracle name" };

    const wakeOpts: { task?: string; prompt?: string; fresh?: boolean; attach?: boolean } = {};
    if (body.task) wakeOpts.task = body.task as string;
    if (body.issue) {
      const issueNum = body.issue as number;
      wakeOpts.prompt = await fetchGitHubPrompt("issue", issueNum, body.repo as string | undefined);
      if (!wakeOpts.task) wakeOpts.task = `issue-${issueNum}`;
    }
    if (body.fresh) wakeOpts.fresh = true;
    if (body.attach) wakeOpts.attach = true;

    await cmdWake(oracle, wakeOpts);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
