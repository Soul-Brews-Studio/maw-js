import { tmux as defaultTmux } from "../../sdk";

export interface ContextLimitProbeDeps {
  capture?: (target: string, lines?: number) => Promise<string>;
  sendText?: (target: string, text: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  warn?: (message: string) => void;
}

export interface ContextLimitRecoveryOptions extends ContextLimitProbeDeps {
  pollMs?: number;
  intervalMs?: number;
  lines?: number;
  label?: string;
}

const CONTEXT_LIMIT_PATTERNS = [
  /context limit reached/i,
  /\/compact\s+or\s+\/clear\s+to\s+continue/i,
  /compact\s+or\s+clear\s+to\s+continue/i,
] as const;

const DEFAULT_POLL_MS = 5000;
const DEFAULT_INTERVAL_MS = 750;
const DEFAULT_LINES = 20;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isContextLimitOutput(output: string | null | undefined): boolean {
  if (!output) return false;
  return CONTEXT_LIMIT_PATTERNS.some(pattern => pattern.test(output));
}

/**
 * Only panes that plausibly host an interactive agent need a capture probe.
 * This keeps `maw ls` from running a capture for every plain shell pane while
 * still covering Claude, Codex, node/bun wrappers, and version-named panes.
 */
export function isLikelyAgentPaneCommand(command: string | undefined): boolean {
  if (!command) return false;
  const cmd = command.toLowerCase().trim();
  if (!cmd) return false;
  if (/claude|codex|node|bun/.test(cmd)) return true;
  return /^\d+\.\d+\.\d+$/.test(cmd);
}

export async function checkPaneContextLimit(
  target: string,
  deps: ContextLimitProbeDeps & { lines?: number } = {},
): Promise<boolean> {
  const capture = deps.capture ?? defaultTmux.capture?.bind(defaultTmux);
  if (!capture) return false;
  const lines = deps.lines ?? DEFAULT_LINES;
  const output = await capture(target, lines).catch(() => "");
  return isContextLimitOutput(output);
}

export async function waitForPaneContextLimit(
  target: string,
  opts: ContextLimitRecoveryOptions = {},
): Promise<boolean> {
  const pollMs = Math.max(0, opts.pollMs ?? DEFAULT_POLL_MS);
  const intervalMs = Math.max(50, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const now = opts.now ?? Date.now;
  const doSleep = opts.sleep ?? sleep;
  const deadline = now() + pollMs;

  while (true) {
    if (await checkPaneContextLimit(target, opts)) return true;
    if (now() >= deadline) return false;
    await doSleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
}

export async function compactIfPaneContextLimited(
  target: string,
  opts: ContextLimitRecoveryOptions = {},
): Promise<boolean> {
  const frozen = await waitForPaneContextLimit(target, opts);
  if (!frozen) return false;

  const sendText = opts.sendText ?? defaultTmux.sendText?.bind(defaultTmux);
  if (!sendText) return false;
  await sendText(target, "/compact");

  const label = opts.label ?? target;
  const warn = opts.warn ?? console.warn;
  warn(`  \x1b[33m⚠\x1b[0m ${label}: context limit hit — sent /compact`);
  return true;
}
