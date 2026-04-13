import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { parseFlags } from "../../../cli/parse-args";

export const command = {
  name: "wake",
  description: "Spawn or attach to an oracle session",
};

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  // Dynamic imports — clean, one await, mockable
  const { cmdWake } = await import("../../wake");
  const { cmdWakeAll } = await import("../../fleet");
  const { parseWakeTarget, ensureCloned } = await import("../../wake-target");
  const { fetchGitHubPrompt } = await import("../../wake-resolve");

  const logs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: any[]) => logs.push(a.map(String).join(" "));

  try {
    if (ctx.source === "cli") {
      const args = ctx.args as string[];

      if (!args[0]) {
        return {
          ok: false,
          error: "usage: maw wake <oracle|org/repo|URL> [task] [--task \"<prompt>\"] [--new <name>] [--fresh] [--no-attach] [--issue N] [--pr N] [--repo org/name] [--list]\n       maw wake all [--kill]",
        };
      }

      if (args[0].toLowerCase() === "all") {
        const flags = parseFlags(args, { "--kill": Boolean, "--all": Boolean, "--resume": Boolean }, 1);
        await cmdWakeAll({ kill: flags["--kill"], all: flags["--all"], resume: flags["--resume"] });
        return { ok: true, output: logs.join("\n") || undefined };
      }

      const flags = parseFlags(args, {
        "--new": String, "--incubate": String, "--issue": Number,
        "--pr": Number, "--repo": String, "--task": String,
        "--fresh": Boolean, "--no-attach": Boolean, "--list": Boolean, "--ls": "--list",
      }, 1);

      const wakeOpts: {
        task?: string; newWt?: string; prompt?: string;
        incubate?: string; fresh?: boolean; noAttach?: boolean; listWt?: boolean;
      } = {};
      let issueNum: number | null = flags["--issue"] ?? null;
      let repo: string | undefined = flags["--repo"];

      const parsed = parseWakeTarget(args[0]);
      const oracleName = parsed ? parsed.oracle : args[0];
      if (parsed) {
        await ensureCloned(parsed.slug);
        if (parsed.issueNum) { issueNum = parsed.issueNum; repo = parsed.slug; }
      }

      if (flags["--new"]) wakeOpts.newWt = flags["--new"];
      if (flags["--incubate"]) wakeOpts.incubate = flags["--incubate"];
      if (flags["--fresh"]) wakeOpts.fresh = true;
      if (flags["--no-attach"]) wakeOpts.noAttach = true;
      if (flags["--list"]) wakeOpts.listWt = true;
      if (flags["--task"]) wakeOpts.noAttach = true;

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

    const wakeOpts: { task?: string; prompt?: string; fresh?: boolean; noAttach?: boolean } = {};
    if (body.task) wakeOpts.task = body.task as string;
    if (body.issue) {
      const issueNum = body.issue as number;
      wakeOpts.prompt = await fetchGitHubPrompt("issue", issueNum, body.repo as string | undefined);
      if (!wakeOpts.task) wakeOpts.task = `issue-${issueNum}`;
    }
    if (body.fresh) wakeOpts.fresh = true;
    if (body.noAttach) wakeOpts.noAttach = true;

    await cmdWake(oracle, wakeOpts);
    return { ok: true, output: logs.join("\n") || undefined };
  } catch (e: any) {
    return { ok: false, error: logs.join("\n") || e.message, output: logs.join("\n") || undefined };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}
