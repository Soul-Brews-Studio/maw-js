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
 *
 * Phase 2 widening (#? — registry phase 2): re-exports the helpers that
 * Phase 1 extraction blocked on. Audit at /tmp/sdk-widen-audit.md (this PR);
 * progress trace at /tmp/extraction-progress.md (30 plugins failed preflight D
 * because they reach into ../../../<core|cli|config|lib>). Re-exporting the
 * specific symbols here unblocks the second wave without forcing every plugin
 * to vendor the same helpers.
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

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 widening — re-exports for plugin extraction Phase 2.
// Grouped by source module. Plugin consumers listed in /tmp/sdk-widen-audit.md.
// ═══════════════════════════════════════════════════════════════════════════

// ─── src/cli/parse-args ──────────────────────────────────────────────────────
// Permissive flag parser (arg). Used by signals, pulse, workspace, zoom,
// kill, capture, panes, split, contacts, tag, locate.
// NOTE: also re-exported from "@maw-js/sdk/plugin" for ergonomics — both work.
export { parseFlags } from "../../src/cli/parse-args";

// ─── src/config ──────────────────────────────────────────────────────────────
// Operator config loader + key-typed accessors. Used by:
//   loadConfig    — consent, ping, health, send, run, send-enter, contacts,
//                   talk-to, avengers, locate, overview
//   cfgTimeout    — ping, health
//   buildCommand        — workon
//   buildCommandInDir   — take
export {
  loadConfig,
  cfgTimeout,
  buildCommand,
  buildCommandInDir,
} from "../../src/config";

// ─── src/core/matcher/resolve-target ─────────────────────────────────────────
// Bare-name → ResolveResult cascade (exact / suffix / prefix / hint).
//   resolveSessionTarget   — zoom, kill, capture, panes, tag, split, locate
//   resolveWorktreeTarget  — workon
// `ResolveResult<T>` is the discriminated-union return shape.
export {
  resolveSessionTarget,
  resolveWorktreeTarget,
} from "../../src/core/matcher/resolve-target";
export type { ResolveResult } from "../../src/core/matcher/resolve-target";

// ─── src/core/matcher/normalize-target ───────────────────────────────────────
// Normalize trailing-slash / `.git` artifacts on user-typed names.
//   normalizeTarget — split
export { normalizeTarget } from "../../src/core/matcher/normalize-target";

// ─── src/core/ghq ────────────────────────────────────────────────────────────
// Repo-discovery helpers (ghq-style suffix lookup).
//   ghqFind     — workon, locate
//   ghqFindSync — restart
export { ghqFind, ghqFindSync } from "../../src/core/ghq";

// ─── src/core/consent ────────────────────────────────────────────────────────
// Trust + consent primitives. Used exclusively by the `consent` plugin.
export {
  listPending,
  listTrust,
  recordTrust,
  removeTrust,
  approveConsent,
  rejectConsent,
} from "../../src/core/consent";
export type { ConsentAction } from "../../src/core/consent";

// ─── src/core/util/terminal ──────────────────────────────────────────────────
// Hyperlink helper for OSC-8-capable terminals.
//   tlink — check
export { tlink } from "../../src/core/util/terminal";

// ─── src/lib/profile-loader ──────────────────────────────────────────────────
// Active-profile pointer + JSON profile read/write. Used by `profile` plugin.
export {
  getActiveProfile,
  loadAllProfiles,
  loadProfile,
  setActiveProfile,
} from "../../src/lib/profile-loader";

// ─── src/lib/schemas ─────────────────────────────────────────────────────────
// Profile shape (TypeBox-derived). Used by `profile` plugin.
export type { TProfile } from "../../src/lib/schemas";

// ─── src/lib/artifacts ───────────────────────────────────────────────────────
// Artifact dir/spec/meta/result helpers. Used by `artifact-manager` plugin.
export {
  createArtifact,
  updateArtifact,
  writeResult,
  addAttachment,
  listArtifacts,
  getArtifact,
  artifactDir,
} from "../../src/lib/artifacts";
export type { ArtifactMeta, ArtifactSummary } from "../../src/lib/artifacts";
