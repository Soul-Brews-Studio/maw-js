/**
 * `maw pane peek <pane-ref>` — alias to `maw tmux peek`.
 *
 * Per #1269, this is a thin re-export so `maw pane peek` behaves identically
 * to the existing `maw tmux peek` (which itself is the canonical pane-content
 * reader). No reimplementation — same resolver, same buffer-capture, same
 * `--lines`/`--history` semantics.
 */
import { cmdTmuxPeek, type TmuxPeekOpts } from "../tmux/impl";

export type PanePeekOpts = TmuxPeekOpts;

export async function cmdPanePeek(ref: string, opts: PanePeekOpts = {}): Promise<void> {
  if (!ref) throw new Error("pane-ref required (try: %N, session:w.p, or team-agent name)");
  await cmdTmuxPeek(ref, opts);
}
