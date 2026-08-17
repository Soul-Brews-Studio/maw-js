import { spawn } from "child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";

import { mawStatePath } from "../../../core/xdg";
import type { RelayCloseOptions, RelayCloseState } from "./impl";

export interface RelayRuntimePaths {
  statePath: string;
  logPath: string;
}

export function relayRuntimePaths(jobId: string): RelayRuntimePaths {
  const root = mawStatePath("relay-close");
  return {
    statePath: `${root}/${jobId}.json`,
    logPath: `${root}/${jobId}.log`,
  };
}

export function createStateRecorder(statePath: string) {
  return (state: RelayCloseState): void => {
    mkdirSync(dirname(statePath), { recursive: true });
    const temp = `${statePath}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    renameSync(temp, statePath);
  };
}

export function buildRelayWorkerArgs(opts: RelayCloseOptions, jobId: string): string[] {
  return [
    "relay-close",
    opts.target,
    "--retrospective", opts.retrospectivePath,
    "--handoff", opts.handoffPath,
    "--timeout", String((opts.timeoutMs ?? 300_000) / 1_000),
    "--run",
    "--job-id", jobId,
  ];
}

export function currentMawCommand(
  argv: string[] = process.argv,
  execPath: string = process.execPath,
  isFile: (path: string) => boolean = path => {
    try { return statSync(path).isFile(); } catch { return false; }
  },
): { command: string; argsPrefix: string[] } {
  if (argv[0] && argv[1] && isFile(argv[1])) {
    return { command: execPath, argsPrefix: [argv[1]] };
  }
  return { command: execPath || argv[0] || "maw", argsPrefix: [] };
}

type WorkerBootstrapOutcome =
  | { kind: "running" }
  | { kind: "error"; error: Error }
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null };

export async function waitForWorkerBootstrap(
  child: ReturnType<typeof spawn>,
  graceMs = 500,
): Promise<WorkerBootstrapOutcome> {
  return Promise.race([
    new Promise<WorkerBootstrapOutcome>(resolve => {
      child.once("error", error => resolve({ kind: "error", error }));
      child.once("exit", (code, signal) => resolve({ kind: "exit", code, signal }));
    }),
    Bun.sleep(graceMs).then((): WorkerBootstrapOutcome => ({ kind: "running" })),
  ]);
}

export async function scheduleRelayClose(opts: RelayCloseOptions): Promise<{
  jobId: string;
  pid: number;
  paths: RelayRuntimePaths;
}> {
  const jobId = opts.jobId ?? `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const paths = relayRuntimePaths(jobId);
  mkdirSync(dirname(paths.statePath), { recursive: true });
  const record = createStateRecorder(paths.statePath);
  record({
    status: "scheduled",
    target: opts.target,
    retrospectivePath: opts.retrospectivePath,
    handoffPath: opts.handoffPath,
    updatedAt: new Date().toISOString(),
    jobId,
    recoveryCommand: `/recap ${opts.handoffPath}`,
  });

  const outFd = openSync(paths.logPath, "a");
  const maw = currentMawCommand();
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(maw.command, [...maw.argsPrefix, ...buildRelayWorkerArgs(opts, jobId)], {
      detached: true,
      stdio: ["ignore", outFd, outFd],
      env: process.env,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record({
      status: "failed",
      target: opts.target,
      retrospectivePath: opts.retrospectivePath,
      handoffPath: opts.handoffPath,
      updatedAt: new Date().toISOString(),
      jobId,
      recoveryCommand: `/recap ${opts.handoffPath}`,
      error: `failed to start relay-close worker: ${message}`,
    });
    throw error;
  } finally {
    closeSync(outFd);
  }
  if (!child.pid) {
    const error = new Error("failed to start relay-close worker: no child PID");
    record({
      status: "failed",
      target: opts.target,
      retrospectivePath: opts.retrospectivePath,
      handoffPath: opts.handoffPath,
      updatedAt: new Date().toISOString(),
      jobId,
      recoveryCommand: `/recap ${opts.handoffPath}`,
      error: error.message,
    });
    throw error;
  }
  record({
    status: "scheduled",
    target: opts.target,
    retrospectivePath: opts.retrospectivePath,
    handoffPath: opts.handoffPath,
    updatedAt: new Date().toISOString(),
    jobId,
    pid: child.pid,
    recoveryCommand: `/recap ${opts.handoffPath}`,
  });
  const bootstrap = await waitForWorkerBootstrap(child);
  if (bootstrap.kind !== "running" && (bootstrap.kind === "error" || bootstrap.code !== 0)) {
    const detail = bootstrap.kind === "error"
      ? bootstrap.error.message
      : `exit ${bootstrap.code ?? "null"}${bootstrap.signal ? ` (${bootstrap.signal})` : ""}`;
    const error = new Error(`relay-close worker failed during bootstrap: ${detail}`);
    record({
      status: "failed",
      target: opts.target,
      retrospectivePath: opts.retrospectivePath,
      handoffPath: opts.handoffPath,
      updatedAt: new Date().toISOString(),
      jobId,
      pid: child.pid,
      recoveryCommand: `/recap ${opts.handoffPath}`,
      error: error.message,
    });
    throw error;
  }
  child.unref();
  return { jobId, pid: child.pid, paths };
}
