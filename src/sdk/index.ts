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

export {
  loadConfig, saveConfig, buildCommand, buildCommandInDir,
  getEnvVars, cfgTimeout, cfgLimit, cfgInterval, cfg, D,
  resetConfig,
} from "../config";
export type { MawConfig } from "../config";

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
export { curlFetch } from "../core/transport/curl-fetch";
export {
  getPeers, getFederationStatus, findPeerForTarget,
} from "../core/transport/peers";
export { resolveTarget } from "../core/routing";
export type { ResolveResult } from "../core/routing";
export { findWindow } from "../core/runtime/find-window";
export type { Session, Window } from "../core/runtime/find-window";

// ─── Runtime ─────────────────────────────────────────────────────────────────

export { runHook } from "../core/runtime/hooks";
export { getTriggers, getTriggerHistory } from "../core/runtime/triggers";

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

// ─── Plugin System ───────────────────────────────────────────────────────────

export { discoverPackages, invokePlugin } from "../plugin/registry";
export { parseManifest, loadManifestFromDir } from "../plugin/manifest";
export { registerCommand, matchCommand, listCommands } from "../cli/command-registry";

// ─── Helpers ─────────────────────────────────────────────────────────────────

export { parseFlags } from "../cli/parse-args";

// ─── Transport Router ────────────────────────────────────────────────────────

export {
  createTransportRouter, getTransportRouter, resetTransportRouter,
} from "../transports";
export { TransportRouter, classifyError } from "../core/transport/transport";
export type {
  Transport, TransportTarget, TransportMessage, TransportPresence,
  TransportResult, TransportFailureReason,
} from "../core/transport/transport";

// ─── Bud (create a new oracle) ───────────────────────────────────────────────

export { cmdBud } from "../commands/plugins/bud/impl";
export type { BudOpts } from "../commands/plugins/bud/impl";
export {
  cmdBudFromRepo, looksLikeUrl, planFromRepoInjection, formatPlan,
} from "../commands/plugins/bud/from-repo";
export {
  initVault, generateClaudeMd, configureFleet, writeBirthNote,
} from "../commands/plugins/bud/bud-init";
export { finalizeBud } from "../commands/plugins/bud/bud-wake";
export type { BudFinalizeCtx } from "../commands/plugins/bud/bud-wake";
export { ensureBudRepo } from "../commands/plugins/bud/bud-repo";
export type { FromRepoOpts, InjectionPlan, InjectionAction } from "../commands/plugins/bud/types";

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
  /** The handler — one function, all surfaces (cli/api/peer) */
  handler: (ctx: InvokeContext) => Promise<InvokeResult>;
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
  if (typeof config.handler !== "function") throw new Error("definePlugin: handler is required");
  return config;
}
