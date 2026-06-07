import { loadConfig, type MawConfig } from "maw-js/sdk";
import { spawnSync } from "node:child_process";

export type ForwardErrorMessage = {
  error: string;
  cwd: string;
  exitCode: number | null;
  timestamp: string;
};

export type ForwardErrorOptions = {
  target?: string;
  last?: number;
};

type SpawnResult = {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error;
};

type ForwardErrorDeps = {
  loadConfig: () => MawConfig;
  spawnSync: (command: string, args: string[], options?: Record<string, unknown>) => SpawnResult;
  cwd: () => string;
  now: () => Date;
  env: Record<string, string | undefined>;
};

const DEFAULT_LAST_LINES = 30;
const MAX_LAST_LINES = 500;

export function parseForwardErrorArgs(args: string[]): ForwardErrorOptions {
  const opts: ForwardErrorOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") throw new Error(usage());
    if (arg === "--to") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) throw new Error("missing value for --to\n" + usage());
      opts.target = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--to=")) {
      opts.target = arg.slice("--to=".length);
      if (!opts.target) throw new Error("missing value for --to\n" + usage());
      continue;
    }
    if (arg === "--last") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) throw new Error("missing value for --last\n" + usage());
      opts.last = parseLast(value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--last=")) {
      opts.last = parseLast(arg.slice("--last=".length));
      continue;
    }
    throw new Error(`unknown argument: ${arg}\n${usage()}`);
  }
  return opts;
}

export async function cmdForwardError(options: ForwardErrorOptions = {}, deps: ForwardErrorDeps = defaultDeps()): Promise<ForwardErrorMessage> {
  const config = deps.loadConfig();
  const target = options.target ?? config.errorForward?.target ?? "doctor";
  const last = normalizeLast(options.last);
  const captured = capturePane(last, deps);
  const message: ForwardErrorMessage = {
    error: captured,
    cwd: deps.cwd(),
    exitCode: readExitCode(deps.env),
    timestamp: deps.now().toISOString(),
  };

  const send = deps.spawnSync("maw", ["hey", target, JSON.stringify(message)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (send.error) throw new Error(`maw hey failed: ${send.error.message}`);
  if (send.status !== 0) {
    const stderr = stringify(send.stderr).trim();
    const stdout = stringify(send.stdout).trim();
    throw new Error(`maw hey failed${send.status === null ? "" : ` (exit ${send.status})`}${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""}`);
  }

  console.log(`forwarded last ${last} line(s) to ${target}`);
  return message;
}

function capturePane(last: number, deps: ForwardErrorDeps): string {
  const result = deps.spawnSync("tmux", ["capture-pane", "-p", "-S", `-${last}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`tmux capture-pane failed: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = stringify(result.stderr).trim();
    throw new Error(`tmux capture-pane failed${result.status === null ? "" : ` (exit ${result.status})`}${stderr ? `: ${stderr}` : ""}`);
  }
  return stringify(result.stdout).replace(/\s+$/u, "");
}

function readExitCode(env: Record<string, string | undefined>): number | null {
  const raw = env.MAW_FORWARD_EXIT_CODE ?? env.MAW_LAST_EXIT_CODE ?? env.LAST_EXIT_CODE;
  if (!raw || !/^-?\d+$/.test(raw)) return null;
  return Number(raw);
}

function parseLast(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`invalid --last value '${value}'`);
  return normalizeLast(Number(value));
}

function normalizeLast(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LAST_LINES;
  if (!Number.isFinite(value) || value < 1) throw new Error("--last must be a positive integer");
  return Math.min(MAX_LAST_LINES, Math.trunc(value));
}

function stringify(value: string | Buffer | undefined): string {
  return typeof value === "string" ? value : value?.toString("utf8") ?? "";
}

function usage(): string {
  return "usage: maw forward-error [--to <target>] [--last N]";
}

function defaultDeps(): ForwardErrorDeps {
  return {
    loadConfig,
    spawnSync: (command, args, options) => spawnSync(command, args, options),
    cwd: () => process.cwd(),
    now: () => new Date(),
    env: process.env,
  };
}
