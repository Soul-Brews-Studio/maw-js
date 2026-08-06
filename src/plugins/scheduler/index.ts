import type { InvokeContext, InvokeResult } from "../../../plugin/types";
import { defaultMawHey, runHook, type HookDeps } from "./hooks";
import { isDue, loadJobs, markDone, markStarted, nextDueAt, parseEvery, readState, schedulerPaths, setEnabled, validateJobPrompt, type SchedulerJob } from "./jobs";

export const command = {
  name: "scheduler",
  description: "File-based job scheduler — dispatch maw hey on a timer",
};

type SchedulerCliDeps = HookDeps & {
  cwd?: string;
  paths?: ReturnType<typeof schedulerPaths>;
  now?: () => number;
};

function argsFrom(ctx: InvokeContext): string[] {
  return Array.isArray(ctx.args) ? ctx.args : [];
}

function flagValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function jsonFlag(args: string[], ctx: InvokeContext): boolean {
  return args.includes("--json") || ctx.flags?.json === true;
}

function jobName(args: string[], ctx: InvokeContext): string | undefined {
  return flagValue(args, "--name") ?? (typeof ctx.flags?.name === "string" ? ctx.flags.name : undefined) ?? args.find((arg, idx) => idx > 0 && !arg.startsWith("-"));
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return "never";
  return new Date(ts).toISOString();
}

async function runJobNow(job: SchedulerJob, stateFile: string, deps: SchedulerCliDeps = {}, dryRun = false): Promise<void> {
  validateJobPrompt(job.prompt);
  if (dryRun) return;
  markStarted(stateFile, job.name, deps.now?.() ?? Date.now());
  for (const hook of job.hooks?.before ?? []) await runHook(hook, job, deps);
  const code = await (deps.mawHey ?? defaultMawHey)(job.target, job.prompt);
  if (code !== 0) throw new Error(`maw hey failed for '${job.name}' with exit code ${code}`);
  markDone(stateFile, job.name, deps.now?.() ?? Date.now());
  for (const hook of job.hooks?.after ?? []) await runHook(hook, job, deps);
}

export async function handleScheduler(ctx: InvokeContext, deps: SchedulerCliDeps = {}): Promise<InvokeResult> {
  const logs: string[] = [];
  let wroteToWriter = false;
  const write = (...args: unknown[]) => {
    if (ctx.writer) {
      wroteToWriter = true;
      ctx.writer(...args);
      return;
    }
    logs.push(args.map(String).join(" "));
  };
  const args = argsFrom(ctx);
  const sub = args[0] ?? "status";
  const paths = deps.paths ?? schedulerPaths(deps.cwd ?? process.cwd());
  const state = readState(paths.stateFile);

  try {
    if (sub === "start") {
      const next = setEnabled(paths.stateFile, true);
      if (jsonFlag(args, ctx)) write(JSON.stringify({ enabled: next.enabled }, null, 2));
      else write("scheduler enabled");
    } else if (sub === "stop") {
      const next = setEnabled(paths.stateFile, false);
      if (jsonFlag(args, ctx)) write(JSON.stringify({ enabled: next.enabled }, null, 2));
      else write("scheduler disabled");
    } else if (sub === "list" || sub === "status") {
      const jobs = loadJobs(paths.jobsFile).jobs;
      const rows = jobs.map((job) => {
        const record = state.jobs?.[job.name] ?? {};
        return { name: job.name, every: job.every, target: job.target, prompt: job.prompt, lastRun: record.lastRun ?? null, nextDue: nextDueAt(job, state), due: isDue(job, state, deps.now?.() ?? Date.now()) };
      });
      if (jsonFlag(args, ctx)) write(JSON.stringify({ enabled: state.enabled !== false, jobs: rows }, null, 2));
      else if (rows.length === 0) write("no scheduler jobs configured");
      else {
        write(`scheduler ${state.enabled === false ? "disabled" : "enabled"} — ${rows.length} job(s)`);
        for (const row of rows) write(`${row.name} every=${row.every} target=${row.target} last=${formatTime(row.lastRun)} next=${formatTime(row.nextDue)} due=${row.due}`);
      }
    } else if (sub === "run") {
      const name = jobName(args, ctx);
      if (!name) return { ok: false, error: "usage: maw scheduler run <name> [--dry-run]" };
      const jobs = loadJobs(paths.jobsFile).jobs;
      const job = jobs.find((item) => item.name === name);
      if (!job) return { ok: false, error: `scheduler job not found: ${name}` };
      await runJobNow(job, paths.stateFile, deps, args.includes("--dry-run") || ctx.flags?.["dry-run"] === true);
      write(`${args.includes("--dry-run") ? "would run" : "ran"} scheduler job '${name}'`);
    } else if (sub === "parse-every") {
      write(String(parseEvery(args[1] ?? "")));
    } else {
      return { ok: false, error: `unknown scheduler subcommand: ${sub}\nusage: maw scheduler <start|stop|status|list|run> [--name <job>] [--json]` };
    }
    return { ok: true, output: wroteToWriter ? undefined : logs.join("\n") || undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), output: wroteToWriter ? undefined : logs.join("\n") || undefined };
  }
}

export default handleScheduler;
