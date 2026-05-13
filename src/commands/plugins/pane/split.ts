/**
 * `maw pane split` — split a tmux pane and run a command in the new one.
 *
 * Per #1269 proposal:
 *   maw pane split [-h|-v] [-p PERCENT] [-t SESSION:WINDOW] <command>
 *
 * Differences from `maw tmux split` (which is the lower-level primitive):
 *   - target is a `-t` FLAG (defaults to $TMUX_PANE), not a positional
 *   - command is POSITIONAL (default: open a shell)
 *   - `-h` is horizontal (side-by-side), `-v` is vertical (stacked) — same
 *     as raw tmux's split-window orientation flags
 *
 * Delegates the actual tmux invocation to `cmdTmuxSplit` so we never re-implement
 * pane-ref resolution or pct validation.
 */
import { cmdTmuxSplit } from "../tmux/impl";
import { isClaudeLikePane, callerPaneCarveRefusal } from "../tmux/safety";
import { hostExec } from "../../../sdk";

export interface PaneSplitOpts {
  /** Horizontal split (side-by-side). Mutually exclusive with vertical. */
  horizontal?: boolean;
  /** Vertical split (stacked top/bottom). Mutually exclusive with horizontal. */
  vertical?: boolean;
  /** Size percent (1-99). Default 50. */
  pct?: number;
  /** Target pane/window to split. Default: $TMUX_PANE (current pane). */
  target?: string;
}

/**
 * Run `tmux split-window` on a target, optionally with a command in the new pane.
 *
 * Resolution rules — see `resolveTmuxTarget` in tmux/impl.ts:
 *   - "%N" pane id        → as-is
 *   - "session:window.pane" → as-is
 *   - team-agent name     → resolved via team config
 *   - bare session name   → first pane of session
 *
 * @param command   command to run in the new pane (empty → login shell)
 * @param opts      orientation, pct, target
 */
export async function cmdPaneSplit(command: string, opts: PaneSplitOpts = {}): Promise<void> {
  // Opts-only validation first — these checks don't depend on environment, so
  // they should fire deterministically regardless of $TMUX state (otherwise
  // test runs without $TMUX would mask real opts misuse).
  if (opts.horizontal && opts.vertical) {
    throw new Error("-h and -v are mutually exclusive");
  }

  if (!process.env.TMUX && !opts.target) {
    throw new Error("maw pane split requires either an active tmux session ($TMUX) or an explicit -t target");
  }

  // Default target = caller's pane (anchors split to where the user typed
  // the command, matching the implicit behavior of raw `tmux split-window`
  // — but explicit so concurrent splits don't drift).
  const target = opts.target ?? process.env.TMUX_PANE ?? "";
  if (!target) {
    throw new Error("no target — pass -t SESSION:WINDOW or run inside a tmux pane");
  }

  // Foot-gun refusal (#1303): when no explicit `-t` target is supplied, the
  // caller's pane ($TMUX_PANE) gets carved. If the caller is running a
  // claude-like process (Claude Code session), refuse outright. Mirror of
  // the gate in `maw split` — see split/impl.ts for full rationale.
  if (!opts.target && process.env.TMUX_PANE) {
    let callerCmd: string | undefined;
    try {
      const out = await hostExec(
        `tmux display-message -p -t '${process.env.TMUX_PANE.replace(/'/g, "'\\''")}' '#{pane_current_command}'`,
      );
      callerCmd = out.trim();
    } catch {
      // Lookup failure is rare; don't block legitimate splits on it.
    }
    if (isClaudeLikePane(callerCmd)) {
      throw new Error(callerPaneCarveRefusal(process.env.TMUX_PANE, callerCmd));
    }
  }

  // Default vertical=false (= horizontal). `-h` is the default tmux orientation
  // semantically (left/right split-window without a flag is `-h`); we keep it.
  // If the user passed `-v` we honor it.
  const vertical = !!opts.vertical;

  await cmdTmuxSplit(target, {
    vertical,
    pct: opts.pct,
    cmd: command || undefined,
  });
}
