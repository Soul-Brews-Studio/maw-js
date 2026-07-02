import { pollPrsOnce as defaultPollPrsOnce } from "../../core/worklog/pr-watch";

// ponytail: fixed 2-min interval; override via MAW_PR_WATCH_INTERVAL_MS if load matters.
const DEFAULT_INTERVAL_MS = 120_000;

type TimerHandle = { unref?: () => void };
type SetIntervalFn = (handler: () => void, ms: number) => TimerHandle;
type ClearIntervalFn = (timer: TimerHandle) => void;

type ServePrWatchDeps = {
  pollPrsOnce: typeof defaultPollPrsOnce;
  setInterval: SetIntervalFn;
  clearInterval: ClearIntervalFn;
  intervalMs: number;
};

const defaultDeps: ServePrWatchDeps = {
  pollPrsOnce: defaultPollPrsOnce,
  setInterval: (handler, ms) => setInterval(handler, ms) as unknown as TimerHandle,
  clearInterval: (timer) => clearInterval(timer as unknown as ReturnType<typeof setInterval>),
  intervalMs: Number(process.env.MAW_PR_WATCH_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
};

/**
 * Start a periodic PR poll for the serve lifecycle. Each tick runs the same
 * on-demand `pollPrsOnce` (open→review, merge→done off the card.pr link), so a
 * plain github.com web-merge drives the linked card WITHOUT a human running any
 * `maw` command. pollPrsOnce is self-throttling via its snapshot diff — a tick
 * with no PR transition is a couple of `gh pr list` calls and no writes.
 */
export function startServePrWatch(
  deps: Partial<ServePrWatchDeps> = {},
): { ok: true; stop: () => void } {
  const d = { ...defaultDeps, ...deps };
  const timer = d.setInterval(() => {
    void d.pollPrsOnce().catch(() => { /* never let a poll error kill serve */ });
  }, d.intervalMs);
  // Don't keep the server process alive just for this timer.
  timer.unref?.();
  return { ok: true, stop: () => d.clearInterval(timer) };
}

export function serve(
  _ctx: Record<string, unknown> = {},
  deps?: Partial<ServePrWatchDeps>,
): { ok: true; stop: () => void } {
  return startServePrWatch(deps);
}

export default serve;
