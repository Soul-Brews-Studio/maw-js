import { hostExec, listSessions, tmuxCmd } from "maw-js/sdk";
import { loadFleet } from "maw-js/commands/shared/fleet-load";
import { resolveAttachTarget } from "../attach/resolve-attach-target";

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

  const [left, right] = target.includes(":")
    ? target.split(":", 2)
    : [target, undefined];
  const isTmuxWindowSuffix = right !== undefined && /^\d+(?:\.\d+)?$/.test(right);
  const rawSession = right !== undefined && !isTmuxWindowSuffix ? right : left;
  const explicitWindow = isTmuxWindowSuffix ? right : undefined;
  const sessions = await listSessions();
  const result = await resolveAttachTarget(rawSession, { listSessions: async () => sessions as any, loadFleet });

  if (!result || result.tier !== 1) {
    console.error(`  \x1b[90m  try: maw ls\x1b[0m`);
    throw new Error(`session '${rawSession}' not found`);
  }
  if (result.ambiguousCandidates && result.ambiguousCandidates.length > 1) {
    console.error(`  \x1b[31m✗\x1b[0m '${rawSession}' is ambiguous — matches ${result.ambiguousCandidates.length} sessions:`);
    for (const s of result.ambiguousCandidates) console.error(`  \x1b[90m    • ${s}\x1b[0m`);
    throw new Error(`'${rawSession}' is ambiguous — matches ${result.ambiguousCandidates.length} sessions`);
  }

  const matched = sessions.find(s => s.name === result.sessionName);
  const windowIndex = explicitWindow ?? matched?.windows?.[0]?.index ?? 0;
  const resolved = `${result.sessionName}:${windowIndex}`;

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
