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
  loadConfigWithProvenance,
  cfgTimeout,
  buildCommand,
  buildCommandInDir,
} from "../../src/config";
export { getGhqRoot } from "../../src/config/ghq-root";

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

// ─── src/core/xdg ───────────────────────────────────────────────────────────
// XDG-aware maw path helpers. Used by messages extraction and other plugins
// that need stable state/data/config/cache paths without reaching into core.
export {
  legacyMawPath,
  isMawXdgEnabled,
  mawConfigDir,
  mawRuntimeHomeDir,
  mawDataDir,
  mawStateDir,
  mawCacheDir,
  mawConfigPath,
  mawDataPath,
  mawMessageLogPath,
  legacyOracleMessageLogPath,
  mawMessageLogCandidatePaths,
  legacyOracleHookConfigPath,
  mawHookConfigCandidatePaths,
  mawStatePath,
  mawCachePath,
} from "../../src/core/xdg";

// ─── src/lib/message-events ─────────────────────────────────────────────────
// Message lifecycle helpers + types used by the messages plugin ledger.
export type { FeedEvent, FeedEventType } from "../../src/lib/feed";
export {
  buildMessageLifecycleData,
  buildMessageLifecycleFeedEvent,
  isMessageLifecycleData,
} from "../../src/lib/message-events";
export type {
  MessageChannel,
  MessageDirection,
  MessageLifecycleData,
  MessageLifecycleInput,
  MessageRoute,
  MessageState,
} from "../../src/lib/message-events";

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

// ─── src/plugin/registry ─────────────────────────────────────────────────────
// Runtime bridge for cross-plugin helper reuse. A plugin must opt in via
// plugin.json module.path + module.exports before another plugin may import it.
export { importPluginSymbol } from "../../src/plugin/registry";


// ─── src/core/agent-detect ──────────────────────────────────────────────────
// Lightweight agent-pane detection used by broadcast and send helpers.
export { isAgentCommand } from "../../src/core/agent-detect";

// ─── src/lib/oracle-members ─────────────────────────────────────────────────
// Team registry readers used by broadcast-style plugins.
export { loadOracleRegistry, getOracleMembers, filterMembers } from "../../src/lib/oracle-members";
export type { OracleMember, OracleTeamRegistry } from "../../src/lib/oracle-members";

// ─── src/core/fleet/fleet-load-core ─────────────────────────────────────────
// Core-only fleet config reads. Avoids src/commands/shared/fleet-load because
// that module imports the SDK barrel for tmux helpers.
export {
  fleetDirsForRead as fleetLoadDirsForRead,
  fleetDirForWrite as fleetLoadDirForWrite,
  loadFleet as loadFleetCore,
  countDisabledFleetFiles as countDisabledFleetFilesCore,
  loadDisabledFleetEntries as loadDisabledFleetEntriesCore,
  loadFleetEntries,
} from "../../src/core/fleet/fleet-load-core";
export type {
  FleetWindow, FleetSession, FleetEntry, DisabledFleetEntry,
} from "../../src/core/fleet/fleet-load-core";

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

// ─── src/commands/shared/channel-loader ─────────────────────────────────────
// Channel config loader API for extracted channel plugins. Wake/build-command
// still import the source module directly; this is a pure SDK barrel export.
export {
  loadOracleChannels,
  saveOracleChannels,
  listAllOracleChannels,
  loadRepoChannels,
  saveRepoChannels,
  getChannelEnv,
} from "../../src/commands/shared/channel-loader";
export type { ChannelPlugin, OracleChannelConfig } from "../../src/commands/shared/channel-loader";
