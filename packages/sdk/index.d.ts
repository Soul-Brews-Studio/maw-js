/**
 * @maw-js/sdk — stable typed API for maw-js plugin authors.
 *
 * Hand-authored declaration file. Self-contained — safe to ship
 * through file:, tarball, or npm install with no path dependencies.
 * Mirrors the runtime shape at src/core/runtime/sdk.ts.
 */

// --- Core types (mirror src/lib/schemas.ts) ---

export interface Identity {
  node: string;
  version: string;
  agents: string[];
  clockUtc: string;
  uptime: number;
}

export interface Peer {
  url: string;
  reachable: boolean;
  latency?: number;
  node?: string;
  agents?: string[];
  clockDeltaMs?: number;
  clockWarning?: boolean;
}

export interface FederationStatus {
  localUrl: string;
  peers: Peer[];
  totalPeers: number;
  reachablePeers: number;
  clockHealth?: {
    clockUtc: string;
    timezone: string;
    uptimeSeconds: number;
  };
}

export interface Session {
  name: string;
  source?: string;
  windows: Array<{
    index: number;
    name: string;
    active: boolean;
  }>;
}

export interface FeedEvent {
  timestamp: string;
  oracle: string;
  host: string;
  event: FeedEventType;
  project: string;
  sessionId: string;
  message: string;
  ts: number;
  data?: unknown;
}

export type FeedEventType =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "UserPromptSubmit"
  | "SubagentStart"
  | "SubagentStop"
  | "TaskCompleted"
  | "SessionEnd"
  | "SessionStart"
  | "Stop"
  | "Notification"
  | "MessageSend"
  | "MessageDeliver"
  | "MessageFail"
  | "WormholeRequest"
  | "WormholeFail"
  | "PluginHook"
  | "PluginFilter"
  | "PluginLoad"
  | "PluginError";

export interface PluginInfo {
  name: string;
  type: string;
  source: string;
  loadedAt: string;
  events: number;
  errors: number;
}

// --- Print helpers ---

export interface PrintHelpers {
  header(text: string): void;
  ok(text: string): void;
  warn(text: string): void;
  err(text: string): void;
  dim(text: string): void;
  list(items: string[], dot?: string, color?: string): void;
  kv(key: string, value: string): void;
  table(rows: string[][], header?: string[]): void;
  nl(): void;
}

// --- maw SDK surface ---

export interface MawSdk {
  /** Node identity: name, version, agents, clock. */
  identity(): Promise<Identity>;
  /** Federation status: peers, latency, clock drift. */
  federation(): Promise<FederationStatus>;
  /** Local + federated sessions. */
  sessions(local?: boolean): Promise<Session[]>;
  /** Feed events. */
  feed(limit?: number): Promise<FeedEvent[]>;
  /** Plugin stats. */
  plugins(): Promise<{
    plugins: PluginInfo[];
    totalEvents: number;
    totalErrors: number;
  }>;
  /** Node config (masked). */
  config(): Promise<Record<string, unknown>>;
  /** Wake an oracle. */
  wake(target: string, task?: string): Promise<{ ok: boolean }>;
  /** Sleep an oracle. */
  sleep(target: string): Promise<{ ok: boolean }>;
  /** Send a message to an agent. */
  send(target: string, text: string): Promise<{ ok: boolean }>;
  /** Colored terminal output helpers. */
  print: PrintHelpers;
  /** Base URL of the local maw serve (http://localhost:port). */
  baseUrl(): string;
  /** Typed fetch against maw serve — throws on failure. */
  fetch<T>(path: string, init?: RequestInit & { timeout?: number }): Promise<T>;
}

export declare const maw: MawSdk;
export default maw;

// --- tmux SDK surface (#855) ---
// Self-contained mirror of src/core/transport/tmux-class.ts. Hand-authored
// so file:/tarball installs from outside the repo type-check cleanly. Only
// the most-used methods are surfaced — the runtime class has more, but
// this is the stable contract plugin authors can rely on.

export interface TmuxPane {
  id: string;
  command: string;
  target: string;
  title: string;
  pid?: number;
  cwd?: string;
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
  cwd?: string;
}

export interface TmuxSession {
  name: string;
  windows: TmuxWindow[];
}

export declare class Tmux {
  constructor(host?: string, socket?: string);
  run(subcommand: string, ...args: (string | number)[]): Promise<string>;
  tryRun(subcommand: string, ...args: (string | number)[]): Promise<string>;
  listSessions(): Promise<TmuxSession[]>;
  listAll(): Promise<TmuxSession[]>;
  hasSession(name: string): Promise<boolean>;
  killSession(name: string): Promise<void>;
  listWindows(session: string): Promise<TmuxWindow[]>;
  newWindow(
    session: string,
    name: string,
    opts?: { cwd?: string },
  ): Promise<void>;
  selectWindow(target: string): Promise<void>;
  switchClient(session: string): Promise<void>;
  killWindow(target: string): Promise<void>;
  listPanes(): Promise<TmuxPane[]>;
  killPane(target: string): Promise<void>;
  getPaneCommand(target: string): Promise<string>;
  capture(target: string, lines?: number): Promise<string>;
  sendKeys(target: string, ...keys: string[]): Promise<void>;
  sendKeysLiteral(target: string, text: string): Promise<void>;
  sendText(target: string, text: string): Promise<void>;
}

/** Default tmux instance — use this for the local socket. */
export declare const tmux: Tmux;

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 widening — self-contained type mirrors for the new re-exports
// added in index.ts. See /tmp/sdk-widen-audit.md for the symbol → consumer
// mapping. These declarations must NOT use parent-relative imports
// (the sdk-package test asserts this).
// ═══════════════════════════════════════════════════════════════════════════

// --- src/cli/parse-args ---

/**
 * Permissive flag parser — wraps `arg` with `permissive: true` so unknown
 * flags fall through to positional args. Mirrors src/cli/parse-args.ts.
 */
export declare function parseFlags<T extends Record<string, unknown>>(
  args: string[],
  spec: T,
  skip?: number,
): { [key: string]: unknown; _: string[] };

// --- src/commands/shared/comm ---

/** Peek/capture a target session or window and print the result. */
export declare function cmdPeek(query?: string): Promise<void>;

/** Send a message to an oracle/window target. */
export declare function cmdSend(target: string, message: string, force?: boolean): Promise<void>;

// --- src/config ---

/** Loaded operator config — opaque to plugins; consume via `cfg*` accessors. */
export interface MawConfig {
  [key: string]: unknown;
}

/** Read the merged operator config (file + env overrides). */
export declare function loadConfig(): MawConfig;

/** Source file discovered while building operator config. */
export interface ConfigSource {
  path: string;
  weight: number;
  isLocal: boolean;
  scope: string;
  scopeRank: number;
  depth: number;
  mtimeMs: number;
}

export interface ConfigProvenanceEntry {
  path: string;
  scope: string;
  weight: number;
  isLocal: boolean;
  action: string;
  value: unknown;
}

/** Config loaded with provenance details and warnings. */
export interface LoadedConfigWithProvenance {
  config: MawConfig;
  sources: ConfigSource[];
  provenance: Record<string, ConfigProvenanceEntry[]>;
  warnings: string[];
}

export interface LoadConfigOptions {
  cwd?: string;
}

/** Read merged config plus merge provenance and warnings. */
export declare function loadConfigWithProvenance(opts?: LoadConfigOptions): LoadedConfigWithProvenance;

/** Look up a named timeout (ms). Throws on unknown key. */
export declare function cfgTimeout(key: string): number;

/** Build the agent command line for the configured agent. */
export declare function buildCommand(agentName: string): string;

/** Build the agent command line, anchored to a specific cwd. */
export declare function buildCommandInDir(agentName: string, cwd: string): string;

/** Resolve the bare ghq root without the github.com host suffix. */
export declare function getGhqRoot(): string;

// --- src/core/matcher/resolve-target ---

/** Discriminated-union result of a bare-name resolution attempt. */
export type ResolveResult<T extends { name: string }> =
  | { kind: "none"; hints?: T[] }
  | { kind: "exact"; match: T }
  | { kind: "fuzzy"; match: T }
  | { kind: "ambiguous"; candidates: T[] };

/** Resolve a session target (fleet-aware: NN-<oracle> handling). */
export declare function resolveSessionTarget<T extends { name: string }>(
  target: string,
  items: readonly T[],
): ResolveResult<T>;

/** Resolve a worktree target (numeric prefix is sequence, not boundary). */
export declare function resolveWorktreeTarget<T extends { name: string }>(
  target: string,
  items: readonly T[],
): ResolveResult<T>;

// --- src/core/matcher/normalize-target ---

/** Strip trailing `/`, `.git`, `.git/` from a user-typed name. */
export declare function normalizeTarget(raw: string): string;

// --- src/core/ghq ---

/** Find a repo path whose suffix matches; returns null if absent. */
export declare function ghqFind(suffix: string): Promise<string | null>;

/** Synchronous variant of ghqFind. */
export declare function ghqFindSync(suffix: string): string | null;

// --- src/core/consent ---

export type ConsentAction = "hey" | "team-invite" | "plugin-install";
export type ConsentStatus = "pending" | "approved" | "rejected" | "expired";

export interface TrustEntry {
  from: string;
  to: string;
  action: ConsentAction;
  pinHash: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface PendingRequest {
  id: string;
  from: string;
  to: string;
  action: ConsentAction;
  status: ConsentStatus;
  createdAt: string;
  expiresAt: string;
  message?: string;
}

/** List pending consent requests on disk. */
export declare function listPending(): PendingRequest[];

/** List recorded trust entries on disk. */
export declare function listTrust(): TrustEntry[];

/** Record a new trust entry. */
export declare function recordTrust(entry: TrustEntry): void;

/** Remove a trust entry; returns true if a matching entry was deleted. */
export declare function removeTrust(
  from: string,
  to: string,
  action: ConsentAction,
): boolean;

/** Approve a pending request and record trust on success. */
export declare function approveConsent(
  requestId: string,
  pin: string,
): Promise<{ ok: boolean; error?: string; entry?: TrustEntry }>;

/** Reject a pending request. */
export declare function rejectConsent(
  requestId: string,
): { ok: boolean; error?: string };

// --- src/core/util/terminal ---

/** Wrap a URL in an OSC-8 hyperlink escape; falls back to plain text. */
export declare function tlink(url: string, text?: string): string;

// --- src/lib/profile-loader ---

/** Profile shape (mirrors src/lib/schemas.ts Profile/TProfile). */
export interface TProfile {
  name: string;
  plugins?: string[];
  tiers?: Array<"core" | "standard" | "extra">;
  description?: string;
}

/** Read the active profile name; defaults to `"all"` if no pointer file. */
export declare function getActiveProfile(): string;

/** Load every profile under `<CONFIG_DIR>/profiles/`. Sorted by name. */
export declare function loadAllProfiles(): TProfile[];

/** Load a single profile by name; null if missing or invalid. */
export declare function loadProfile(name: string): TProfile | null;

/** Atomically write the active-profile pointer file. */
export declare function setActiveProfile(name: string): void;

// --- src/plugin/registry ---

/**
 * Import a whitelisted named symbol from another installed plugin's module surface.
 * The provider plugin must declare plugin.json module.path + module.exports.
 */
export declare function importPluginSymbol<T = unknown>(
  pluginName: string,
  symbolName: string,
): Promise<T>;


// --- src/core/agent-detect ---

/** Return true when a tmux pane command appears to be an agent runtime. */
export declare function isAgentCommand(cmd: string | null | undefined): boolean;

// --- src/lib/oracle-members ---

export interface OracleMember {
  oracle: string;
  role: string;
  addedAt: string;
}

export interface OracleTeamRegistry {
  name: string;
  members: OracleMember[];
  createdAt: string;
  excludeSelf?: boolean;
}

export declare function loadOracleRegistry(teamName: string): OracleTeamRegistry | null;
export declare function filterMembers(
  members: OracleMember[],
  excludeSelf: boolean | undefined,
  currentOracle?: string,
): string[];
export declare function getOracleMembers(teamName: string, currentOracle?: string): string[];

// --- src/core/fleet/fleet-load-core ---

export interface FleetWindow {
  name: string;
  repo: string;
}

export interface FleetSession {
  name: string;
  windows: FleetWindow[];
  skip_command?: boolean;
  sync_peers?: string[];
  budded_from?: string;
  project_repos?: string[];
}

export interface FleetEntry {
  file: string;
  path?: string;
  num: number;
  groupName: string;
  session: FleetSession;
}

export interface DisabledFleetEntry {
  file: string;
  path: string;
  num: number;
  groupName: string;
  session?: FleetSession;
  error?: unknown;
}

export declare function fleetLoadDirsForRead(legacyFleetDir?: string): string[];
export declare function fleetLoadDirForWrite(): string;
export declare function loadFleetCore(dirs?: string[]): FleetSession[];
export declare function countDisabledFleetFilesCore(dirs?: string[]): number;
export declare function loadDisabledFleetEntriesCore(dirs?: string[]): DisabledFleetEntry[];
export declare function loadFleetEntries(dirs?: string[]): FleetEntry[];

/** Stop all configured fleet sessions. */
export declare function cmdSleep(): Promise<void>;

// --- src/lib/artifacts ---

export interface ArtifactMeta {
  team: string;
  taskId: string;
  subject: string;
  owner?: string;
  status: "pending" | "in_progress" | "completed";
  createdAt: string;
  updatedAt: string;
  commitHash?: string;
}

export interface ArtifactSummary {
  team: string;
  taskId: string;
  subject: string;
  status: string;
  owner?: string;
  files: number;
  hasResult: boolean;
  createdAt: string;
}

/** Create artifact dir + spec.md + meta.json. Returns the dir path. */
export declare function createArtifact(
  team: string,
  taskId: string,
  subject: string,
  description: string,
): string;

/** Merge updates into meta.json; bumps updatedAt. */
export declare function updateArtifact(
  team: string,
  taskId: string,
  updates: Partial<ArtifactMeta>,
): void;

/** Write result.md and mark artifact completed. */
export declare function writeResult(
  team: string,
  taskId: string,
  content: string,
): void;

/** Add an attachment file to an artifact. Returns the written path. */
export declare function addAttachment(
  team: string,
  taskId: string,
  name: string,
  data: Buffer | string,
): string;

/** List all artifacts, optionally filtered by team. */
export declare function listArtifacts(teamFilter?: string): ArtifactSummary[];

/** Get full artifact contents (spec + result + attachment list). */
export declare function getArtifact(
  team: string,
  taskId: string,
): {
  meta: ArtifactMeta;
  spec: string;
  result: string | null;
  attachments: string[];
  dir: string;
} | null;

/** Get the artifact directory path (for agents to write into). */
export declare function artifactDir(team: string, taskId: string): string;

// --- src/core/xdg ---

export declare function legacyMawPath(...parts: string[]): string;
export declare function isMawXdgEnabled(): boolean;
export declare function mawConfigDir(): string;
export declare function mawRuntimeHomeDir(): string;
export declare function mawDataDir(): string;
export declare function mawStateDir(): string;
export declare function mawCacheDir(): string;
export declare function mawConfigPath(...parts: string[]): string;
export declare function mawDataPath(...parts: string[]): string;
export declare function mawMessageLogPath(): string;
export declare function legacyOracleMessageLogPath(): string;
export declare function mawMessageLogCandidatePaths(): string[];
export declare function legacyOracleHookConfigPath(): string;
export declare function mawHookConfigCandidatePaths(): string[];
export declare function mawStatePath(...parts: string[]): string;
export declare function mawCachePath(...parts: string[]): string;

// --- src/lib/message-events ---

export type MessageDirection = "outbound" | "inbound" | "forwarded";
export type MessageState = "queued" | "delivered" | "failed";
export type MessageChannel = "hey" | "send" | "api-send" | "plugin";
export type MessageRoute = "local" | "peer" | "discovery" | "self-node" | "team" | string;

export interface MessageLifecycleData {
  id: string;
  ts: string;
  direction: MessageDirection;
  state: MessageState;
  channel: MessageChannel;
  route: MessageRoute;
  from: string;
  to: string;
  target?: string;
  peerUrl?: string;
  text: string;
  error?: string;
  lastLine?: string;
  signed?: boolean;
}

export type MessageLifecycleInput = Omit<MessageLifecycleData, "id" | "ts"> & {
  id?: string;
  ts?: string | number | Date;
};

export declare function buildMessageLifecycleData(input: MessageLifecycleInput): MessageLifecycleData;
export declare function buildMessageLifecycleFeedEvent(input: MessageLifecycleInput): FeedEvent;
export declare function isMessageLifecycleData(value: unknown): value is MessageLifecycleData;

// --- src/commands/shared/channel-loader ---

export interface ChannelPlugin {
  id: string;
  env?: Record<string, string>;
}

export interface OracleChannelConfig {
  plugins: ChannelPlugin[];
  token_source?: string;
  permissionMode?: "skip" | "relay";
}

export declare function loadOracleChannels(oracleStem: string): OracleChannelConfig | null;
export declare function saveOracleChannels(oracleStem: string, config: OracleChannelConfig): void;
export declare function listAllOracleChannels(): Array<{ oracle: string; plugins: ChannelPlugin[] }>;
export declare function loadRepoChannels(repoPath: string): OracleChannelConfig | null;
export declare function saveRepoChannels(repoPath: string, config: OracleChannelConfig): void;
export declare function getChannelEnv(
  oracleStem: string,
  fleetEnvOverride?: Record<string, string>,
  repoPath?: string,
): Record<string, string>;

// --- src/commands/shared/scan-signals ---

export type SignalKind = "info" | "alert" | "pattern";

export interface Signal {
  timestamp: string;
  bud: string;
  kind: SignalKind;
  message: string;
  context?: Record<string, unknown>;
}

export interface ScannedSignal extends Signal {
  file: string;
}

export declare function scanSignals(root: string, opts?: { days?: number }): ScannedSignal[];

// --- src/commands/shared/wake ---

export declare function fetchIssuePrompt(num: number, repo?: string): Promise<string>;
export declare function cmdWake(oracle: string, opts: Record<string, unknown>): Promise<string>;
