import { Tmux, tmux } from "./tmux-class";

// ─── Pane creation lock ────────────────────────────────────────────────────
// tmux assigns pane indices in command order, but simultaneous split-window
// calls interleave — the expected index-after-split is racy when two agents
// spawn concurrently (see PaneBackendExecutor in Claude Code source). This
// in-process Promise queue serializes pane creation across callers within
// a single maw invocation. Cross-process races would need a file lock; all
// current callers (split, bud, team-agents) run inside one process.

let paneQueue: Promise<unknown> = Promise.resolve();

/** Serialize an async operation behind the shared pane-creation queue. */
export async function withPaneLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = paneQueue;
  let release!: () => void;
  paneQueue = new Promise<void>((r) => { release = r; });
  try {
    await prev.catch(() => {}); // wait for predecessor; swallow its errors
    return await fn();
  } finally {
    release();
  }
}

export interface SplitWindowLockedOpts {
  /** Split vertical (top/bottom). Default: horizontal (side-by-side). */
  vertical?: boolean;
  /** Percentage size of new pane (1-99). */
  pct?: number;
  /** Shell command to run in the new pane. Default: shell. */
  shellCommand?: string;
  /** Settle delay after split before releasing lock, in ms. Default: 200. */
  settleMs?: number;
  /** Tmux instance override (mainly for tests). */
  tmux?: Tmux;
}

/**
 * Lock-protected split. Acquires the pane queue, runs split-window with the
 * given options, waits `settleMs` for tmux to register the pane, then releases.
 * The settle is the cheapest way to give tmux's event loop a tick before the
 * next caller asks for the new pane's index.
 */
export async function splitWindowLocked(
  target: string,
  opts: SplitWindowLockedOpts = {},
): Promise<void> {
  const t = opts.tmux ?? tmux;
  const settleMs = opts.settleMs ?? 200;
  return withPaneLock(async () => {
    const args: (string | number)[] = ["-t", target];
    if (opts.vertical === true) args.push("-v");
    else if (opts.vertical === false) args.push("-h");
    if (opts.pct !== undefined) args.push("-l", `${opts.pct}%`);
    if (opts.shellCommand) args.push(opts.shellCommand);
    await t.run("split-window", ...args);
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
  });
}
