import { readFileSync, realpathSync, statSync } from "fs";
import { resolve } from "path";

import { tmux } from "maw-js/sdk";

export const RELAY_CLOSE_USAGE = "usage: maw relay-close [exact-pane] --retrospective <path> --handoff <path> [--timeout <seconds>] [--foreground|--dry-run]";

export type RelayCloseStatus =
  | "scheduled"
  | "validating"
  | "waiting-idle"
  | "clearing"
  | "recapping"
  | "complete"
  | "failed";

export interface RelayCloseOptions {
  target: string;
  retrospectivePath: string;
  handoffPath: string;
  timeoutMs?: number;
  pollMs?: number;
  foreground?: boolean;
  dryRun?: boolean;
  internalRun?: boolean;
  jobId?: string;
}

export interface RelayCloseState {
  status: RelayCloseStatus;
  target: string;
  retrospectivePath: string;
  handoffPath: string;
  updatedAt: string;
  jobId?: string;
  pid?: number;
  recoveryCommand?: string;
  error?: string;
}

interface ArtifactStat { isFile: boolean; mtimeMs: number }
export const relayCaptureArgs = (target: string) => ["capture-pane", "-t", target, "-e", "-J", "-p"] as const;

export interface RelayCloseDeps {
  capture: (target: string, lines?: number) => Promise<string>;
  submitCommand: (target: string, text: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  realpath: (path: string) => string;
  stat: (path: string) => ArtifactStat;
  readFile: (path: string) => string;
  recordState: (state: RelayCloseState) => void;
}

const realDeps: RelayCloseDeps = {
  // Current screen only: scrollback may contain stale Claude banners and old-context witnesses.
  capture: (target) => tmux.run(...relayCaptureArgs(target)),
  submitCommand: async (target, text) => {
    await tmux.exitModeIfNeeded(target);
    await tmux.sendKeysLiteral(target, text);
    await tmux.sendKeys(target, "Enter");
  },
  sleep: (ms) => Bun.sleep(ms),
  now: Date.now,
  realpath: (path) => realpathSync(resolve(path)),
  stat: (path) => {
    const value = statSync(path);
    return { isFile: value.isFile(), mtimeMs: value.mtimeMs };
  },
  readFile: (path) => readFileSync(path, "utf-8"),
  recordState: () => {},
};

function valueAfter(args: string[], flag: string): string | undefined {
  const equals = args.find(arg => arg.startsWith(`${flag}=`));
  if (equals) return equals.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function parseRelayCloseArgs(
  args: string[],
  env: Pick<NodeJS.ProcessEnv, "TMUX_PANE"> = process.env,
): RelayCloseOptions {
  const explicitTarget = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
  const target = explicitTarget ?? env.TMUX_PANE;
  if (!target) throw new Error(`${RELAY_CLOSE_USAGE}\nexact-pane is required outside tmux`);
  if (!/^%\d+$/.test(target) && !/^.+:.+\.\d+$/.test(target)) {
    throw new Error(`relay-close requires an exact pane target, got: ${target}`);
  }
  const retrospectivePath = valueAfter(args, "--retrospective");
  if (!retrospectivePath) throw new Error(`${RELAY_CLOSE_USAGE}\n--retrospective is required`);
  const handoffPath = valueAfter(args, "--handoff");
  if (!handoffPath) throw new Error(`${RELAY_CLOSE_USAGE}\n--handoff is required`);
  const timeoutRaw = valueAfter(args, "--timeout");
  const timeoutSeconds = timeoutRaw === undefined ? 300 : Number(timeoutRaw);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("--timeout must be a positive number of seconds");
  }
  return {
    target,
    retrospectivePath,
    handoffPath,
    timeoutMs: timeoutSeconds * 1_000,
    foreground: args.includes("--foreground"),
    dryRun: args.includes("--dry-run"),
    internalRun: args.includes("--run"),
    jobId: valueAfter(args, "--job-id"),
  };
}

function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

export function isIdleCapture(input: string): boolean {
  const tail = stripAnsi(input).split("\n").slice(-20).map(line => line.trim());
  const busy = tail.some(line => /(Undulating|Working\s*\(|esc to interrupt|Waiting for task)/i.test(line));
  if (busy) return false;
  return tail.some(line => /^[❯›>]\s*$/.test(line));
}

function emit(
  deps: RelayCloseDeps,
  opts: Required<Pick<RelayCloseOptions, "target" | "retrospectivePath" | "handoffPath">>,
  status: RelayCloseStatus,
  error?: string,
): RelayCloseState {
  const state: RelayCloseState = {
    status,
    target: opts.target,
    retrospectivePath: opts.retrospectivePath,
    handoffPath: opts.handoffPath,
    updatedAt: new Date(deps.now()).toISOString(),
    recoveryCommand: `/recap ${opts.handoffPath}`,
    ...(rawJobMeta(opts) ?? {}),
    ...(error ? { error } : {}),
  };
  deps.recordState(state);
  return state;
}

function rawJobMeta(opts: RelayCloseOptions): Pick<RelayCloseState, "jobId" | "pid"> | undefined {
  if (!opts.jobId) return undefined;
  return { jobId: opts.jobId, pid: process.pid };
}

export function validateRelayArtifacts(
  opts: RelayCloseOptions,
  overrides: Partial<RelayCloseDeps> = {},
): RelayCloseOptions {
  const deps = { ...realDeps, ...overrides };
  const retrospectivePath = deps.realpath(opts.retrospectivePath);
  const handoffPath = deps.realpath(opts.handoffPath);
  if ([retrospectivePath, handoffPath].some(path => /[\s\x00-\x1f\x7f]/.test(path))) {
    throw new Error("relay-close artifact paths cannot contain whitespace or control characters");
  }
  const retrospective = deps.stat(retrospectivePath);
  const handoff = deps.stat(handoffPath);
  if (!retrospective.isFile) throw new Error(`retrospective is not a file: ${retrospectivePath}`);
  if (!handoff.isFile) throw new Error(`handoff is not a file: ${handoffPath}`);
  if (!deps.readFile(retrospectivePath).trim()) throw new Error(`retrospective is empty: ${retrospectivePath}`);
  if (!deps.readFile(handoffPath).trim()) throw new Error(`handoff is empty: ${handoffPath}`);
  if (handoff.mtimeMs < retrospective.mtimeMs) {
    throw new Error("handoff must be written after the retrospective");
  }
  return { ...opts, retrospectivePath, handoffPath };
}

async function waitForStableIdle(
  opts: RelayCloseOptions,
  deps: RelayCloseDeps,
  deadline: number,
  changedFrom?: string,
  proof?: string,
  timeoutMessage?: string,
  absentProof?: string,
): Promise<string> {
  let consecutive = 0;
  let changed = changedFrom === undefined;
  while (deps.now() <= deadline) {
    const capture = await deps.capture(opts.target, 80);
    if (changedFrom !== undefined && capture !== changedFrom) changed = true;
    const plain = stripAnsi(capture);
    const proven = (proof === undefined || plain.includes(proof))
      && (absentProof === undefined || !plain.includes(absentProof));
    if (changed && proven && isIdleCapture(capture)) {
      consecutive += 1;
      if (consecutive >= 2) return capture;
    } else {
      consecutive = 0;
    }
    await deps.sleep(opts.pollMs ?? 100);
  }
  throw new Error(timeoutMessage ?? "timed out waiting for the target pane to become idle");
}

function oldContextWitness(capture: string): string | undefined {
  return stripAnsi(capture).split("\n").map(line => line.trim()).reverse().find(line =>
    line.length >= 12
    && !/^[❯›>]/.test(line)
    && !/^[─━═\-]+$/.test(line)
    && !/(Claude Code|Worked for|Churned for|Auto-update|Context \d|ctx\s|inbox:|bypass permissions)/i.test(line)
  );
}

export async function runRelayClose(
  rawOpts: RelayCloseOptions,
  overrides: Partial<RelayCloseDeps> = {},
): Promise<RelayCloseState> {
  const deps = { ...realDeps, ...overrides };
  let opts = rawOpts;
  try {
    emit(deps, opts, "validating");
    opts = validateRelayArtifacts(opts, deps);
    const deadline = deps.now() + (opts.timeoutMs ?? 300_000);
    emit(deps, opts, "waiting-idle");
    const beforeClear = await waitForStableIdle(opts, deps, deadline);
    const beforeWitness = oldContextWitness(beforeClear);
    emit(deps, opts, "clearing");
    await deps.submitCommand(opts.target, "/clear");
    const afterClear = await waitForStableIdle(
      opts,
      deps,
      deadline,
      beforeClear,
      "Claude Code",
      "clear did not reach a fresh Claude Code prompt",
      beforeWitness,
    );
    emit(deps, opts, "recapping");
    await deps.submitCommand(opts.target, `/recap ${opts.handoffPath}`);
    await waitForStableIdle(
      opts,
      deps,
      deadline,
      afterClear,
      `Handoff read: ${opts.handoffPath}`,
      "recap did not acknowledge the handoff",
    );
    return emit(deps, opts, "complete");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(deps, opts, "failed", message);
    throw error;
  }
}
