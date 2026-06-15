import type { InvokeContext } from "../../../plugin/types";
import { defaultMawHey, runHook, type HookDeps } from "./hooks";
import { isDue, loadJobs, markDone, markStarted, readState, schedulerPaths, validateJobPrompt, type SchedulerJob } from "./jobs";

type TimerHandle = { unref?: () => void };
type SetIntervalFn = (handler: () => void, timeout: number) => TimerHandle;

type ServeLog = { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };

export interface SchedulerDaemonDeps extends HookDeps {
  cwd?: string;
  error?: (...args: unknown[]) => void;
  tickMs?: number;
  now?: () => number;
  setInterval?: SetIntervalFn;
  paths?: ReturnType<typeof schedulerPaths>;
}

function unrefTimer(timer: TimerHandle): void {
  timer.unref?.();
}

async function runJob(job: SchedulerJob, stateFile: string, deps: SchedulerDaemonDeps = {}): Promise<void> {
  validateJobPrompt(job.prompt);
  markStarted(stateFile, job.name, deps.now?.() ?? Date.now());
  for (const hook of job.hooks?.before ?? []) await runHook(hook, job, deps);
  const code = await (deps.mawHey ?? defaultMawHey)(job.target, job.prompt);
  if (code !== 0) throw new Error(`maw hey failed for '${job.name}' with exit code ${code}`);
  markDone(stateFile, job.name, deps.now?.() ?? Date.now());
  for (const hook of job.hooks?.after ?? []) await runHook(hook, job, deps);
}

export async function schedulerTick(deps: SchedulerDaemonDeps = {}): Promise<{ ran: string[]; skipped: string[]; disabled: boolean; errors: string[] }> {
  const paths = deps.paths ?? schedulerPaths(deps.cwd ?? process.cwd());
  const state = readState(paths.stateFile);
  if (state.enabled === false) return { ran: [], skipped: [], disabled: true, errors: [] };
  const jobs = loadJobs(paths.jobsFile).jobs;
  const ran: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  for (const job of jobs) {
    if (!isDue(job, state, deps.now?.() ?? Date.now())) {
      skipped.push(job.name);
      continue;
    }
    try {
      await runJob(job, paths.stateFile, deps);
      ran.push(job.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      (deps.error ?? console.error)(`[scheduler] ${message}`);
    }
  }
  return { ran, skipped, disabled: false, errors };
}

export function serve(ctx: Pick<InvokeContext, "source"> & { log?: ServeLog } = { source: "api" }, deps: SchedulerDaemonDeps = {}): { ok: true; timers: TimerHandle[] } {
  const setIntervalFn = deps.setInterval ?? ((handler, timeout) => setInterval(handler, timeout) as TimerHandle);
  const timer = setIntervalFn(() => {
    schedulerTick(deps).catch((err) => ctx.log?.error?.("[scheduler] tick failed:", err));
  }, deps.tickMs ?? 10_000);
  unrefTimer(timer);
  ctx.log?.info?.("[scheduler] serve hook started");
  return { ok: true, timers: [timer] };
}

export default serve;
