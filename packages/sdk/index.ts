/**
 * @maw-js/sdk — stable typed API for maw-js plugin authors.
 *
 * Phase A: re-exports the runtime SDK from maw-js core. When plugins
 * get bundled with `maw plugin build`, the bundler inlines this module.
 * Phase B: swaps to a host-injected shim for runtime capability gating.
 *
 *   import { maw, tmux } from "@maw-js/sdk";
 *   const id = await maw.identity();
 *   const sessions = await tmux.listSessions();
 */

export {
  maw,
  default,
} from "../../src/core/runtime/sdk";

export type {
  Identity,
  Peer,
  FederationStatus,
  Session,
  FeedEvent,
  PluginInfo,
} from "../../src/core/runtime/sdk";

// ─── tmux — top-level transport surface (#855) ───────────────────────────────
// Plugins use `import { tmux } from "@maw-js/sdk"` for tmux ops (list, send,
// capture). The `Tmux` class is also exported for consumers that need to
// construct their own instances (custom socket / remote host).
export { tmux, Tmux } from "../../src/core/transport/tmux";
export type {
  TmuxPane,
  TmuxWindow,
  TmuxSession,
} from "../../src/core/transport/tmux";
