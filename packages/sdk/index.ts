/**
 * @maw-js/sdk — stable typed API for maw-js plugin authors.
 *
 * Phase A: re-exports the runtime SDK from maw-js core. When plugins
 * get bundled with `maw plugin build`, the bundler inlines this module.
 * Phase B: swaps to a host-injected shim for runtime capability gating.
 *
 *   import { maw } from "@maw-js/sdk";
 *   const id = await maw.identity();
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
