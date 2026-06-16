import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { Hook, SchedulerJob } from "./jobs";

export interface HookDeps {
  now?: () => number;
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  schedulerName?: string;
  runShell?: (command: string) => Promise<number>;
  mawHey?: (target: string, message: string) => Promise<number>;
}

async function defaultRunShell(command: string): Promise<number> {
  const proc = Bun.spawn(["sh", "-c", command], { stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

export async function defaultMawHey(target: string, message: string): Promise<number> {
  const proc = Bun.spawn(["maw", "hey", target, message], { stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

export async function runHook(hook: Hook, job: SchedulerJob, deps: HookDeps = {}): Promise<void> {
  if ("run" in hook) {
    const code = await (deps.runShell ?? defaultRunShell)(hook.run);
    if (code !== 0) throw new Error(`hook run failed for '${job.name}' with exit code ${code}`);
    return;
  }
  if ("log" in hook) {
    (deps.log ?? console.log)(`[scheduler] ${hook.log}`);
    return;
  }
  if ("publish" in hook) {
    mkdirSync(dirname(hook.publish), { recursive: true });
    writeFileSync(hook.publish, JSON.stringify({ ts: deps.now?.() ?? Date.now(), job: job.name }, null, 2));
    return;
  }
  if ("maw-hey" in hook) {
    const schedulerName = deps.schedulerName ?? "mawjs-scheduler";
    if (hook["maw-hey"].target === schedulerName) {
      (deps.warn ?? console.warn)(`[scheduler] skipping recursive maw-hey hook for ${job.name}: target ${schedulerName}`);
      return;
    }
    const code = await (deps.mawHey ?? defaultMawHey)(hook["maw-hey"].target, hook["maw-hey"].message);
    if (code !== 0) throw new Error(`maw-hey hook failed for '${job.name}' with exit code ${code}`);
  }
}
