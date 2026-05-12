/**
 * `maw pane kill <pane-ref>` — kill a single pane (not session).
 *
 * Per #1269, this is the granular counterpart to `maw kill` (which targets
 * whole sessions). Always pane-only — to kill a session, use `maw kill` or
 * `maw tmux kill --session`.
 *
 * Delegates to `cmdTmuxKill` (without --session) so fleet/view safety still
 * applies — the underlying helper refuses fleet/view targets unless --force.
 */
import { cmdTmuxKill } from "../tmux/impl";

export interface PaneKillOpts {
  /** Bypass fleet/view session refusal. */
  force?: boolean;
}

export async function cmdPaneKill(ref: string, opts: PaneKillOpts = {}): Promise<void> {
  if (!ref) throw new Error("pane-ref required (try: %N, session:w.p, or team-agent name)");
  await cmdTmuxKill(ref, { force: !!opts.force, session: false });
}
