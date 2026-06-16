import { hostExec, resolvePeekTarget, tmuxCmd } from "maw-js/sdk";

export interface CaptureOpts {
  /** Pane index within the resolved window. Default: current/first. */
  pane?: number;
  /** Number of tail lines. Default: 50. Ignored if --full. */
  lines?: number;
  /** Capture the full scrollback history (-S -). */
  full?: boolean;
}

/**
 * maw capture <target> [--pane N] [--lines N] [--full]
 *
 * Capture tmux pane content. Wraps `tmux capture-pane -p` with sane
 * defaults so skills don't shell out directly.
 *
 *   --pane N    pick a specific pane of the resolved window (default 0)
 *   --lines N   tail the last N lines (default 50)
 *   --full      capture full scrollback — overrides --lines
 */
export async function cmdCapture(target: string, opts: CaptureOpts = {}) {
  if (!target) {
    throw new Error("usage: maw capture <target> [--pane N] [--lines N] [--full]\n  e.g. maw capture mawjs\n       maw capture neo:0 --pane 1 --lines 100\n       maw capture mawjs --full");
  }

  const resolved = await resolvePeekTarget(target);

  if (!resolved) {
    console.error(`  \x1b[90m  try: maw ls\x1b[0m`);
    throw new Error(`target '${target}' not found`);
  }

  const paneSuffix = opts.pane !== undefined ? `.${opts.pane}` : "";
  const full = resolved + paneSuffix;
  const tmux = tmuxCmd();

  try {
    let raw: string;
    if (opts.full) {
      // -S - means "from the beginning of history"
      raw = await hostExec(`${tmux} capture-pane -t '${full}' -p -S -`);
    } else {
      const lines = opts.lines ?? 50;
      raw = await hostExec(`${tmux} capture-pane -t '${full}' -p -S -${lines}`);
    }
    if (raw) console.log(raw);
  } catch (e: any) {
    throw new Error(`capture failed: ${e.message || e}`);
  }
}
