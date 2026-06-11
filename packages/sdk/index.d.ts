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

/** Where a message should be delivered. */
export interface TransportTarget {
  oracle: string;
  host?: string;
  tmuxTarget?: string;
}

/** Failure reasons for transport send attempts. */
export type TransportFailureReason =
  | "timeout"
  | "unreachable"
  | "auth"
  | "rate_limit"
  | "rejected"
  | "parse_error"
  | "unknown";

/** Result of a transport send attempt. */
export interface TransportResult {
  ok: boolean;
  via: string;
  reason?: TransportFailureReason;
  retryable: boolean;
}

/** Event-name → payload registry for plugin event hooks. */
export interface PluginEventMap {
  "transport:before_send": {
    target: TransportTarget;
    message: string;
    from: string;
  };
  "transport:after_send": {
    target: TransportTarget;
    message: string;
    from: string;
    result: TransportResult;
    via: string;
  };
  "transport:receive": {
    from: string;
    body: string;
    transport: string;
    timestamp: number;
  };
  "session:start": {
    oracle: string;
    session: string;
    repoPath: string;
  };
  "session:end": {
    oracle: string;
    session: string;
    window: string;
  };
  "feed:message_send": {
    from: string;
    to: string;
    body: string;
    channel: string;
  };
  "feed:status_change": {
    oracle: string;
    pane: string;
    from: string;
    to: string;
  };
  "serve:start": {
    port: number;
    hostname: string;
  };
  "serve:plugin_loaded": {
    name: string;
    phase: string;
  };
}

export interface PluginInfo {
  name: string;
  type: string;
  source: string;
  loadedAt: string;
  events: number;
  errors: number;
}

// --- plugin manifest helpers (definePlugin) ---

export interface PluginManifestInput {
  /** Plugin name (must match plugin.json name). */
  name: string;
  /** Optional plugin hooks, currently used for typed event handlers. */
  hooks?: {
    on?: readonly string[];
    [key: string]: unknown;
  };
  /** Exports list consumed by module-loader consumers. */
  module: {
    exports: readonly string[];
    path: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type EventToHandlerName<E extends string> =
  E extends `${infer Scope}:${infer Action}`
    ? `on${Capitalize<Lowercase<Scope>>}${PascalFromSnake<Action>}`
    : `on${Capitalize<Lowercase<E>>}`;

type PascalFromSnake<T extends string> = T extends `${infer Head}_${infer Rest}`
  ? `${Capitalize<Lowercase<Head>>}${PascalFromSnake<Rest>}`
  : T extends `${infer Head}-${infer Rest}`
    ? `${Capitalize<Lowercase<Head>>}${PascalFromSnake<Rest>}`
    : Capitalize<Lowercase<T>>;

/** Derive the typed handler map from hook event names. */
export type HandlersFor<Events extends readonly string[]> = {
  [Event in Events[number] as EventToHandlerName<Event>]:
    Event extends keyof PluginEventMap
      ? (event: PluginEventMap[Event]) => void | Promise<void>
      : (event: unknown) => void | Promise<void>;
};

type ManifestHookEvents<T extends PluginManifestInput> =
  T extends { hooks: { on: infer HookEvents } }
    ? HookEvents extends readonly string[]
      ? HookEvents
      : []
    : [];

/** Validate `module.exports` contains all required typed handler names. */
export type ValidateExports<T extends PluginManifestInput> =
  keyof HandlersFor<ManifestHookEvents<T>> extends T["module"]["exports"][number]
    ? T
    : never;

export type DefinedPlugin<T extends PluginManifestInput> =
  ValidateExports<T> & {
    implement(handlers: HandlersFor<ManifestHookEvents<T>>): ValidateExports<T> & HandlersFor<ManifestHookEvents<T>>;
  };

export declare function definePlugin<const T extends PluginManifestInput>(manifest: ValidateExports<T>): DefinedPlugin<T>;

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

/** User-facing command error marker. */
export declare class UserError extends Error {
  readonly isUserError: true;
}

/** True when an error was raised for user-facing command feedback. */
export declare function isUserError(e: unknown): e is UserError;
export declare function assertValidOracleName(name: string): void;
export declare function writeSignal(parentRoot: string, budName: string, payload: { kind: "info" | "alert" | "pattern"; message: string; context?: Record<string, unknown> }): string;
export declare function validateNickname(raw: string): { ok: true; value: string } | { ok: false; error: string };
export declare function writeNickname(repoPath: string, nickname: string): void;
export declare function setCachedNickname(name: string, nickname: string): void;

/** Render numeric buckets as a compact Unicode sparkline. */
export declare function sparkline(values: number[], hadActivity?: boolean[]): string;

// --- src/commands/shared/comm ---

/** Peek/capture a target session or window and print the result. */
export declare function cmdPeek(query?: string): Promise<void>;

/** Send a message to an oracle/window target. */
export declare function cmdSend(target: string, message: string, force?: boolean): Promise<void>;
export declare function resolveOraclePane(target: string): Promise<string>;

export interface PendingMessage {
  id: string;
  sender: string;
  target: string;
  message: string;
  sentAt: string;
  status: "pending" | "approved" | "rejected";
  query?: string;
}
export declare const TTL_MS: number;
export declare function pendingDir(): string;
export declare function pendingPath(id: string): string;
export declare function isExpired(msg: PendingMessage, now?: Date): boolean;
export declare function savePending(input: { sender: string; target: string; message: string; query?: string }): PendingMessage;
export declare function loadPending(): PendingMessage[];
export declare function loadPendingById(id: string): PendingMessage | null;
export declare function updatePending(id: string, patch: Partial<PendingMessage>): PendingMessage;
export declare function deletePending(id: string): boolean;
export declare function cmdSplit(target: string, opts?: Record<string, unknown>): Promise<void>;
export interface AgentRow {
  node: string;
  session: string;
  window: string;
  oracle: string;
  state: "active" | "idle";
  pid: number | null;
}
export declare function buildAgentRows(
  panes: Array<{ command: string; target: string; pid?: number }>,
  windowNames: Map<string, string>,
  nodeName: string,
  opts?: { all?: boolean },
): AgentRow[];

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

export interface TScope {
  name: string;
  members: string[];
  created: string;
  ttl: string | null;
  lead?: string;
}

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
/** Wake all configured fleet sessions. */
export declare function cmdWakeAll(opts?: { kill?: boolean; all?: boolean; resume?: boolean }): Promise<void>;
export declare function detectSession(oracle: string, urlRepoName?: string): Promise<string | null>;

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


export interface SleepLifecycleContextInput {
  oracle: string;
  session: string;
  window: string;
  target: string;
}

export interface LifecycleRunSummary {
  phase: "wake" | "sleep" | "serve";
  ran: number;
  skipped: number;
  failed: number;
}

export declare function runSleepLifecycleHooks(context: SleepLifecycleContextInput): Promise<LifecycleRunSummary>;

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
export interface ParsedWakeTarget { oracle: string; slug: string; issueNum?: number }
export declare function parseWakeTarget(target: string): ParsedWakeTarget | null;
export declare function ensureCloned(slug: string): Promise<void>;
export interface ShouldAutoWakeDecision { wake: boolean; reason: string }
export declare function shouldAutoWake(oracle: string, opts: Record<string, unknown>): ShouldAutoWakeDecision;

// --- src/commands/shared/pulse ---

export declare function cmdPulseAdd(title: string, opts: { oracle?: string; priority?: string; wt?: string }): Promise<void>;
export declare function cmdPulseLs(opts?: { sync?: boolean }): Promise<void>;
// --- SDK parity exports used by repo-vendored plugins (#2750) ---

export interface InvokeContext {
  source: "cli" | "api" | "peer";
  args: string[] | Record<string, unknown>;
}

export interface InvokeResult {
  ok: boolean;
  output?: string;
  error?: string;
}

export interface OracleEntry {
  name: string;
  repo?: string;
  path?: string;
  host?: string;
  session?: string;
  window?: string;
  [key: string]: unknown;
}

export interface OracleManifestEntry {
  name: string;
  path?: string;
  repo?: string;
  host?: string;
  source?: string;
  [key: string]: unknown;
}

export declare class SshAttachError extends Error {
  code: string;
  constructor(message: string, code?: string);
}

export declare const C: Record<string, string>;
export declare function hostExec(host: string | undefined, command: string, opts?: Record<string, unknown>): Promise<string>;
export declare function listSessions(host?: string): Promise<Session[]>;
export declare function capture(target: string, lines?: number, host?: string): Promise<string>;
export declare function sendKeys(target: string, keys: string | string[], host?: string): Promise<void>;
export declare function getPaneCommand(target: string, host?: string): Promise<string>;
export declare function tmuxCmd(): string;
export declare function resolveSocket(): string | undefined;
export declare function withPaneLock<T>(fn: () => Promise<T>): Promise<T>;
export declare function attachRemoteSession(opts: Record<string, unknown>): void;
export declare function curlFetch(url: string, opts?: Record<string, unknown>): Promise<{ ok: boolean; status: number; statusText?: string; text(): Promise<string>; json<T = unknown>(): Promise<T> }>;
export declare function getFederationStatus(): Promise<FederationStatus> | FederationStatus;
export declare function getTransportRouter(): unknown;
export declare function resolveTarget(target: string, opts?: Record<string, unknown>): Promise<unknown> | unknown;
export declare function resolveFleetWindowSessionTarget<T extends { name: string }>(target: string, items: readonly T[]): ResolveResult<T>;
export declare function isInfrastructureChannelSessionName(name: string): boolean;
export declare function findWindow(sessions: Session[], query: string, currentSession?: string): string | null;
export declare function checkBusyGuard(target: string): Promise<unknown>;
export declare function defaultEngineNameForConfig(config?: Partial<MawConfig>): string;
export declare function resolveEngine(name: string, config?: Partial<MawConfig>): unknown;
export declare function matchesEngineIdlePrompt(text: string, engine?: string): boolean;
export declare function runHook(name: string, payload?: unknown): Promise<unknown>;
export declare function getTriggers(): unknown[];
export declare function getTriggerHistory(): unknown[];
export declare function fire(event: unknown, ctx?: Record<string, unknown>): Promise<unknown[]>;
export declare function scanWorktrees(deps?: Record<string, unknown>): Promise<unknown[]>;
export declare function cleanupWorktree(wtPath: string): Promise<string[]>;
export declare function saveTabOrder(session: string): Promise<void>;
export declare function takeSnapshot(trigger: string, retentionPolicy?: Record<string, unknown>): Promise<string>;
export declare function findWorktrees(root?: string): Promise<string[]>;
export declare function ghqList(): Promise<string[]>;
export declare function loadManifestCached(opts?: Record<string, unknown>): Promise<OracleManifestEntry[]> | OracleManifestEntry[];
export declare function invalidateManifest(): void;
export declare function saveConfig(config: Partial<MawConfig>): void;
export declare function cmdWorkspaceCreate(args?: string[], opts?: Record<string, unknown>): Promise<unknown>;
export declare function cmdWorkspaceJoin(args?: string[], opts?: Record<string, unknown>): Promise<unknown>;
export declare function cmdWorkspaceShare(args?: string[], opts?: Record<string, unknown>): Promise<unknown>;
export declare function cmdWorkspaceUnshare(args?: string[], opts?: Record<string, unknown>): Promise<unknown>;
export declare function cmdWorkspaceLs(args?: string[], opts?: Record<string, unknown>): Promise<unknown>;
export declare function cmdWorkspaceAgents(args?: string[], opts?: Record<string, unknown>): Promise<unknown>;
export declare function cmdWorkspaceInvite(args?: string[], opts?: Record<string, unknown>): Promise<unknown>;
export declare function cmdWorkspaceLeave(args?: string[], opts?: Record<string, unknown>): Promise<unknown>;
export declare function cmdWorkspaceStatus(args?: string[], opts?: Record<string, unknown>): Promise<unknown>;

