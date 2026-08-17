/**
 * @maw-js/sdk — the stable API surface for maw-js plugins.
 *
 * TS plugins import from here. WASM plugins get the same capabilities
 * via host functions in wasm-bridge.ts.
 *
 * Rule: if it's not exported here, plugins shouldn't depend on it.
 * This is the contract boundary between core runtime and plugin code.
 */

// ─── Types (shared by TS + WASM plugins) ─────────────────────────────────────

export type {
  PluginManifest,
  LoadedPlugin,
  InvokeContext,
  InvokeResult,
} from "../plugin/types";

// ─── Identity & Config ───────────────────────────────────────────────────────

export { loadConfig } from "../config/load";
export {
  saveConfig, buildCommand, buildCommandInDir,
  getEnvVars, cfgTimeout, cfgLimit, cfgInterval, cfg, D,
  resetConfig,
} from "../config";
export { ENGINE_SEED, defaultEngineNameForConfig, resolveEngine } from "../config/engine-registry";
export { getGhqRoot } from "../config/ghq-root";
export {
  isMawXdgEnabled,
  legacyMawPath,
  mawCacheDir,
  mawConfigDir,
  mawDataDir,
  mawDataPath,
  mawMessageLogPath,
  mawStateDir,
  mawStatePath,
} from "../core/xdg";
export type { EngineDef } from "../config/engine-def";
export type { EngineRegistry } from "../config/engine-registry";
export type { TScope } from "../lib/schemas";
export type { MawConfig } from "../config";

// ─── Consent ────────────────────────────────────────────────────────────────

export {
  listPending, listTrust, recordTrust, removeTrust,
  approveConsent, rejectConsent,
} from "../core/consent";
export type { ConsentAction } from "../core/consent";

// ─── Transport ───────────────────────────────────────────────────────────────

export {
  tmux, Tmux, tmuxCmd, resolveSocket,
  withPaneLock, splitWindowLocked, tagPane, readPaneTags,
} from "../core/transport/tmux";
export type {
  TmuxPane, TmuxWindow, TmuxSession,
  SplitWindowLockedOpts, TagPaneOpts, PaneTags,
} from "../core/transport/tmux";
export {
  hostExec, listSessions, capture, sendKeys,
  getPaneCommand, getPaneCommands, getPaneInfos,
  HostExecError,
} from "../core/transport/ssh";
export type { Session as SshSession, HostExecTransport } from "../core/transport/ssh";
export { attachRemoteSession, SshAttachError } from "../core/transport/ssh-attach";
export type { AttachRemoteSessionOptions } from "../core/transport/ssh-attach";
export { curlFetch } from "../core/transport/curl-fetch";
export {
  getPeers, getFederationStatus, findPeerForTarget,
} from "../core/transport/peers";
export { resolveTarget } from "../core/routing";
export type { ResolveResult } from "../core/routing";
export { resolveSessionTarget, resolveWorktreeTarget, resolveFleetWindowSessionTarget } from "../core/matcher/resolve-target";
export { sanitizeBranchName } from "../commands/shared/sanitize-branch-name";
export { normalizeTarget } from "../core/matcher/normalize-target";
export { isInfrastructureChannelSessionName } from "../core/matcher/channel-session";
export { resolveOracle, pickOracle } from "../core/resolve";
export type {
  OracleRef,
  ResolveOracleOptions,
  ResolveResult as OracleResolveResult,
  PickOracleOptions,
} from "../core/resolve";
export { findWindow } from "../core/runtime/find-window";
export { agentProcessNames, engineIdlePromptPatterns, isAgentCommand, isAgentCommandForConfig, matchesAgentProcessName, matchesEngineIdlePrompt } from "../core/agent-detect";
export { checkBusyGuard, extractOracleName } from "../core/agent-status-guard";
export type { Session, Window } from "../core/runtime/find-window";
export {
  loadOracleChannels,
  saveOracleChannels,
  listAllOracleChannels,
  loadRepoChannels,
  saveRepoChannels,
  getChannelEnv,
} from "../commands/shared/channel-loader";
export type { ChannelPlugin, OracleChannelConfig } from "../commands/shared/channel-loader";
export { scanSignals } from "../commands/shared/scan-signals";
export { resolveOraclePane } from "../commands/shared/comm-send";
export {
  deletePending,
  isExpired,
  loadPending,
  loadPendingById,
  pendingDir,
  pendingPath,
  savePending,
  TTL_MS,
  updatePending,
} from "../commands/shared/queue-store";
export type { PendingMessage } from "../commands/shared/queue-store";
export type { ScannedSignal } from "../commands/shared/scan-signals";

// ─── Runtime ─────────────────────────────────────────────────────────────────

export { runHook } from "../core/runtime/hooks";
export { runSleepLifecycleHooks } from "../plugin/lifecycle";
export type { SleepLifecycleContextInput, LifecycleRunSummary } from "../plugin/lifecycle";
export { getTriggers, getTriggerHistory, fire } from "../core/runtime/triggers";

// ─── Fleet ───────────────────────────────────────────────────────────────────

export { FLEET_DIR, CONFIG_DIR, MAW_ROOT, CONFIG_FILE } from "../core/paths";
export { scanWorktrees, cleanupWorktree } from "../core/fleet/worktrees";
export { saveTabOrder, restoreTabOrder } from "../core/fleet/tab-order";
export { takeSnapshot, listSnapshots, loadSnapshot, latestSnapshot } from "../core/fleet/snapshot";
export { readAudit, logAudit } from "../core/fleet/audit";
export {
  scanLocal, scanRemote, scanFull, scanAndCache,
  readCache, isCacheStale,
} from "../core/fleet/oracle-registry";
export type { OracleEntry, RegistryCache } from "../core/fleet/oracle-registry";
export {
  fleetDirsForRead as fleetLoadDirsForRead,
  fleetDirForWrite as fleetLoadDirForWrite,
  loadFleet as loadFleetCore,
  countDisabledFleetFiles as countDisabledFleetFilesCore,
  loadDisabledFleetEntries as loadDisabledFleetEntriesCore,
  loadFleetEntries,
} from "../core/fleet/fleet-load-core";
export { cmdSleep, cmdWakeAll } from "../commands/shared/fleet-wake";
export { cmdPulseAdd, cmdPulseLs } from "../commands/shared/pulse";
export { cmdWake, fetchIssuePrompt, findWorktrees, detectSession } from "../commands/shared/wake";
export { parseWakeTarget, ensureCloned } from "../commands/shared/wake-target";
export { shouldAutoWake } from "../commands/shared/should-auto-wake";
export type {
  FleetWindow, FleetRuntimeIdentity, FleetSession, FleetEntry, DisabledFleetEntry,
} from "../core/fleet/fleet-load-core";
export { loadOracleRegistry, getOracleMembers, filterMembers } from "../lib/oracle-members";
export type { OracleMember, OracleTeamRegistry } from "../lib/oracle-members";
// Sub-issue 2 of #736 Phase 2 / #836 — unified read-only view across the 5
// oracle registries. Consumer-side rollouts (oracle ls, doctor, resolveTarget)
// land in follow-up PRs.
export {
  loadManifest, findOracle, loadManifestCached, invalidateManifest,
  DEFAULT_TTL_MS as ORACLE_MANIFEST_DEFAULT_TTL_MS,
} from "../lib/oracle-manifest";
export type { OracleManifestEntry, OracleManifestSource } from "../lib/oracle-manifest";

// ─── Artifacts ───────────────────────────────────────────────────────────────

export {
  createArtifact,
  updateArtifact,
  writeResult,
  addAttachment,
  listArtifacts,
  getArtifact,
  artifactDir,
} from "../lib/artifacts";
export type { ArtifactMeta, ArtifactSummary } from "../lib/artifacts";

// ─── Profile Loader ─────────────────────────────────────────────────────────

export {
  getActiveProfile,
  loadAllProfiles,
  loadProfile,
  setActiveProfile,
} from "../lib/profile-loader";
export type { TProfile } from "../lib/schemas";

// ─── Plugin System ───────────────────────────────────────────────────────────

export { discoverPackages, importPluginSymbol, invokePlugin } from "../plugin/registry";
export { parseManifest, loadManifestFromDir } from "../plugin/manifest";
export { registerCommand, matchCommand, listCommands } from "../cli/command-registry";

// ─── Helpers ─────────────────────────────────────────────────────────────────

export { C } from "../commands/shared/fleet-doctor-fixer";
export { parseFlags } from "../cli/parse-args";
export {
  cmdWorkspaceCreate,
  cmdWorkspaceJoin,
  cmdWorkspaceShare,
  cmdWorkspaceUnshare,
  cmdWorkspaceLs,
  cmdWorkspaceAgents,
  cmdWorkspaceInvite,
  cmdWorkspaceLeave,
  cmdWorkspaceStatus,
} from "../commands/shared/workspace";
export { ghqFind, ghqList, ghqFindSync, ghqListSync } from "../core/ghq";
export { UserError, isUserError } from "../core/util/user-error";
export { assertValidOracleName } from "../core/fleet/validate";
export { writeSignal } from "../core/fleet/leaf";
export { validateNickname, writeNickname, setCachedNickname } from "../core/fleet/nicknames";
export { sparkline } from "../lib/sparkline";
export { tlink } from "../core/util/terminal";

// Plugin extraction helpers for tab-like command surfaces.
export { cmdPeek, cmdSend, resolvePeekTarget } from "../commands/shared/comm";
export { updateInboxStatusBadge } from "../commands/shared/inbox-status-badge";
export { cmdSplit } from "../commands/plugins/split/impl";
export { buildAgentRows } from "../commands/shared/agents";
export type { AgentRow } from "../commands/shared/agents";

// ─── Transport Router ────────────────────────────────────────────────────────

export {
  createTransportRouter, getTransportRouter, resetTransportRouter,
} from "../transports";
export { TransportRouter, classifyError } from "../core/transport/transport";
export type {
  Transport, TransportTarget, TransportMessage, TransportPresence,
  TransportResult, TransportFailureReason,
} from "../core/transport/transport";

// ─── Bud — moved to community plugin (registry: maw-bud) ────────────────────
// SDK no longer re-exports bud internals; community plugins consume @maw-js/sdk
// rather than being part of it. Imports are now: registry install + plugin runtime.

// ─── Oracle management ───────────────────────────────────────────────────────

export {
  cmdOracleAbout,
  cmdOracleList,
  cmdOracleScan,
  cmdOracleFleet,
  cmdOracleScanStale,
  cmdOraclePrune,
  cmdOracleRegister,
} from "../commands/plugins/oracle/impl";

// ─── definePlugin — the plugin contract ──────────────────────────────────────

import type { InvokeContext, InvokeResult } from "../plugin/types";

/** Plugin configuration — the type IS the interface */
export interface PluginConfig {
  /** Plugin name (must match plugin.json name) */
  name: string;
  /**
   * Optional handler for command/API/peer entry points.
   *
   * Plugin manifests that use `entry` + `hooks` can omit a top-level handler.
   */
  handler?: (ctx: InvokeContext) => Promise<InvokeResult>;
  /** Phase 0: GATE — return false to cancel event pipeline */
  onGate?: (event: any) => boolean;
  /** Phase 1: FILTER — modify event before handlers */
  onFilter?: (event: any) => any;
  /** Phase 2: HANDLE — observe/react to events */
  onEvent?: (event: any) => void | Promise<void>;
  /** Phase 3: LATE — guaranteed cleanup */
  onLate?: (event: any) => void;
  /** Called when plugin is first installed */
  onInstall?: () => void | Promise<void>;
  /** Called when plugin is removed */
  onUninstall?: () => void | Promise<void>;
}

/**
 * Define a maw-js plugin. Like Vue's defineComponent() — validates
 * the shape, provides autocomplete, zero runtime overhead.
 *
 * ```ts
 * import { definePlugin } from "@maw-js/sdk";
 *
 * export default definePlugin({
 *   name: "my-plugin",
 *   handler(ctx) {
 *     return { ok: true, output: "hello" };
 *   },
 *   onEvent(event) { console.log(event); },
 * });
 * ```
 */
export function definePlugin(config: PluginConfig): PluginConfig {
  if (!config.name) throw new Error("definePlugin: name is required");
  if (config.handler !== undefined && typeof config.handler !== "function") {
    throw new Error("definePlugin: handler must be a function");
  }
  return config;
}
