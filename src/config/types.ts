export type TriggerEvent = "issue-close" | "pr-merge" | "agent-idle" | "agent-wake" | "agent-crash" | "cron";

export interface TriggerConfig {
  on: TriggerEvent;
  repo?: string;       // filter by repo (for issue-close, pr-merge)
  timeout?: number;     // seconds (for agent-idle)
  schedule?: string;    // crontab expression (for cron) — 5-field "m h dom mon dow"
  action: string;       // shell command to execute — supports {agent}, {repo}, {issue} templates
  name?: string;        // optional human label
  once?: boolean;       // fire once then self-destruct (#149)
  /**
   * #2555 — exemption tags that suppress this trigger for matching agents.
   * Currently supports `"channel-listener"`: agents subscribed to a channel
   * plugin (discord/telegram/etc.) are idle-but-waiting for inbound messages
   * and must not be auto-slept. Absent/empty = no exemptions.
   */
  exempt?: string[];
}

/** Named peer with URL */
export interface PeerConfig {
  name: string;
  url: string;
}

export interface MawIntervals {
  capture?: number;
  sessions?: number;
  status?: number;
  teams?: number;
  preview?: number;
  peerFetch?: number;
  crashCheck?: number;
  /** Periodic orphan-PTY sweep cadence (ms). See pty.ts sweepOrphanPtySessions (#P2). */
  ptySweep?: number;
}

export interface MawTimeouts {
  http?: number;
  health?: number;
  ping?: number;
  pty?: number;
  workspace?: number;
  shellInit?: number;
  wakeRetry?: number;
  wakeVerify?: number;
  /** WebSocket idle timeout — SECONDS (Bun API constraint, max 960). Other timeouts here are ms; `Sec` suffix makes the unit explicit. Used by Bun.serve websocket idleTimeout — dead ws closes after this, fires close handler → handlePtyClose → detach → grace-timer reap. */
  wsIdleSec?: number;
}


export interface MawSnapshotRetention {
  /** Keep at least the newest N snapshot files. */
  keepLast?: number;
  /** Remove snapshots older than D days. */
  maxAgeDays?: number;
}


export interface MawRetentionPolicy {
  /** Keep at least the newest N records. */
  keepLast?: number;
  /** Remove records older than D days. */
  maxAgeDays?: number;
}

/**
 * Pane-input guard / deferred-delivery tuning (eq3-003).
 *
 * `maw hey` never overtypes operator input that is mid-edit on the target
 * pane. When the pane is "dirty" (a prompt marker followed by typed text) the
 * message is deferred to the dispatch queue and a 📬 badge appears instantly.
 * It is delivered later — by the hook (`maw flush`), the busy→ready
 * DispatchEngine transition, or the periodic sweep (the hook-independent net) —
 * but only once the pane goes clean. A message stuck behind a dirty pane past
 * `stallNotifyMs` emits a one-shot notify instead of force-delivering.
 */
export interface MawInputGuard {
  /** Pre-send pane-input guard. When false, restores the pre-eq3-003 always-inject behavior. Default true. */
  enabled?: boolean;
  /** Periodic deferred-queue sweep cadence (ms). The hook-independent net: flushes deferred messages once the pane goes clean. Default 5000. */
  sweepIntervalMs?: number;
  /** A deferred message older than this (ms) fires a one-shot stall notify (never overtypes). Default 180000 (3 min). */
  stallNotifyMs?: number;
}

export interface MawLimits {
  feedMax?: number;
  feedDefault?: number;
  feedHistory?: number;
  logsMax?: number;
  logsDefault?: number;
  logsTruncate?: number;
  messageTruncate?: number;
  ptyCols?: number;
  ptyRows?: number;
  /**
   * Max concurrent agent panes across the fleet before `maw wake` refuses to
   * spawn a new one (#2). Defaults to `40`; explicit `0` disables the cap
   * entirely for operators that intentionally want unbounded spawning.
   */
  maxConcurrentAgents?: number;
}

export interface MawConfig {
  host: string;
  port: number;
  /**
   * API server bind address (#713). When present, the HTTP/WS server binds to
   * this address instead of deriving it from `host`. This separates the
   * "listen on all interfaces for federation" concern from the "outbound
   * connection target" concern that `host` represents.
   *
   * Typical value: `"0.0.0.0"` (federation) or `"127.0.0.1"` (local only).
   * When absent, the server falls back to `resolveBindHost()` heuristic.
   */
  bind?: string;
  /**
   * @deprecated (#680) — ghq root is resolved on demand via `ghq root`. If
   * present, this value is honored as a legacy override (normalized to the
   * BARE shape — trailing `/github.com` stripped). Prefer removing it from
   * config and letting `getGhqRoot()` resolve at runtime.
   */
  ghqRoot?: string;
  oracleUrl: string;
  env: Record<string, string>;
  commands: Record<string, string>;
  /** Default engine key/command used when no command-specific fallback is configured (#2400). */
  defaultEngine?: string;
  /** Serve gateway preference (#2566). CLI --gateway and MAW_GATEWAY override this. */
  gateway?: "bun" | "rust";
  /**
   * Generic engine definitions (#1960 P1).
   *
   * Additive/dormant until later phases route command rendering through the
   * engine registry. Legacy `commands` remains the active launch surface today.
   */
  engines?: Record<string, import("./engine-def").EngineDef>;
  sessions: Record<string, string>;
  tmuxSocket?: string;
  peers?: string[];
  idleTimeoutMinutes?: number;
  federationToken?: string;
  /**
   * Explicit opt-in to legacy "peers configured but no token" behavior.
   * When `true`, HMAC is NOT required on protected writes from non-loopback
   * peers even when peers are configured. Default `false` (fail-closed).
   * Setting this to `true` is operator opt-in to the pre-#396 default-
   * insecure-open posture — only use when migrating a legacy mesh.
   */
  allowPeersWithoutToken?: boolean;
  /**
   * Trust loopback connections without HMAC (legacy default: true).
   *
   * When `true` (default), requests arriving with TCP source 127.0.0.1
   * bypass the HMAC check — this is load-bearing for the local CLI,
   * which doesn't sign its own calls yet. BUT: a local reverse proxy
   * (cloudflared, nginx, sidecar) forwarding external traffic to
   * 127.0.0.1 ALSO gets trusted, which is "Path B" from #191 — a
   * foothold an attacker on a compromised local process can use to
   * bypass federation auth entirely.
   *
   * When `false`, loopback requests are required to sign like any
   * other peer. Operators who run `maw serve` behind any local
   * reverse proxy, tunnel, or sidecar MUST set this to `false`.
   * Until CLI self-signing ships, setting this to `false` will
   * break interactive CLI commands; use with care.
   *
   * See ψ/lab/federation-audit/paladin-forensic.md (F3/Path B) for
   * the full threat model.
   */
  trustLoopback?: boolean;
  autoRestart?: boolean;
  triggers?: TriggerConfig[];
  /** Node identity (e.g. "white", "mba") */
  node?: string;
  /**
   * Other names this host also answers to for `node:agent` routing
   * (kobo-431 Option C). Optional, defaults to none.
   *
   * Before this field existed, a `node:agent` query whose node didn't match
   * `node` or a `namedPeers` entry would fall through to a blind fallback
   * that re-resolved the bare agent name locally and delivered if it found a
   * live session — silently guessing that the unrecognized node meant "this
   * host" (eq3-006). That guess is not declared anywhere and can misfire —
   * a genuinely different, unrelated node can coincidentally share a bare
   * agent name. This field replaces the guess with a declaration: list every
   * additional name this host is reachable as, and `node:agent` resolves on
   * the normal self-node path (routing.ts Step 2) instead of guessing. An
   * undeclared unknown node now fails loud instead of silently delivering
   * to a possibly-wrong pane. See docs/federation/getting-started.md.
   */
  hostAliases?: string[];
  /**
   * Optional service user for multi-user hosts (#1814).
   *
   * When set, federation-visible identity becomes `<nodeUser>@<node>` while
   * `node` remains the host-level identity for backwards-compatible config.
   */
  nodeUser?: string;
  /** @deprecated Alias for nodeUser during early #1814 rollout. */
  serviceUser?: string;
  /**
   * Oracle name (e.g. "mawjs", "neo", "colab") — the family identity component
   * of `<oracle>:<node>` per ADR docs/federation/0001-peer-identity.md.
   *
   * Optional; defaults to `"mawjs"` everywhere it is consumed (this codebase
   * is the mawjs lineage). Multi-oracle-per-node is a naming convention, not
   * a protocol concern: oracle names must be unique within a node — the
   * doctor + boot-time check (#804 Step 3) enforces operator awareness.
   *
   * Consumed by v3 from-signing (#804 Step 4) — see DEFAULT_ORACLE in
   * src/lib/federation-auth.ts.
   */
  oracle?: string;
  /** Named peers with URLs */
  namedPeers?: PeerConfig[];
  /** Agent → node mapping (e.g. { "homekeeper": "mba", "neo": "white" }) */
  agents?: Record<string, string>;
  /** GitHub org for maw bud (default: Soul-Brews-Studio) */
  githubOrg?: string;
  /** GitHub orgs to scan for oracle repos (default: Soul-Brews-Studio, laris-co) */
  githubOrgs?: string[];
  /** Fixed Claude session UUIDs per agent */
  sessionIds?: Record<string, string>;
  /** Path to ψ/ directory */
  psiPath?: string;
  /** TLS cert/key paths */
  tls?: { cert: string; key: string };
  /** Zenoh transport — pub/sub/discovery via zenohd remote-api */
  zenoh?: {
    locator?: string;
    scout?: {
      enabled?: boolean;
      locator?: string;
      timeoutMs?: number;
      keyPrefix?: string;
    };
  };
  /**
   * Legacy Scout LAN discovery toggle (#1903).
   *
   * `false` disables the UDP scout transport without changing Zenoh scout or
   * explicit federation peers. Also reachable per-process via
   * `MAW_NO_SCOUT=1` / `maw serve --no-scout`.
   */
  scout?: boolean;
  /** Discovery provider selection for peer presence candidates. */
  discovery?: {
    transport?: "scout" | "zenoh" | "both" | "off";
  };
  /** Polling intervals (ms) */
  intervals?: MawIntervals;
  /** HTTP/operation timeouts (ms) */
  timeouts?: MawTimeouts;
  /** Buffer/display limits */
  limits?: MawLimits;
  /** Pane-input guard / deferred-delivery tuning (eq3-003) */
  inputGuard?: MawInputGuard;
  /** HMAC auth window (seconds) */
  hmacWindowSeconds?: number;
  /** PIN for web UI */
  pin?: string;
  /** Plugin source URLs — auto-installed on bootstrap (nuke → first run) */
  pluginSources?: string[];
  /** Plugin names to disable (skip during scanning and execution) */
  disabledPlugins?: string[];
  /** Transport names that receive best-effort relay sends after primary delivery succeeds (#2497). */
  broadcastTo?: string[];
  /** Default target for `maw forward-error` structured error reports (#2511). */
  errorForward?: {
    target?: string;
  };
  /** Fleet snapshot retention policy (#2146). */
  snapshotRetention?: MawSnapshotRetention;
  /** Message/inbox retention policy (#2165). */
  messageRetention?: MawRetentionPolicy;
  /** One-shot config migrations already applied. */
  migrations?: Record<string, boolean>;
}

/** Typed defaults for intervals, timeouts, limits (#172) */
export const D = {
  intervals: { capture: 50, sessions: 5000, status: 3000, teams: 3000, preview: 2000, peerFetch: 10000, crashCheck: 30000, peerRetryBackoff: 300, ptySweep: 300000 } as const,
  timeouts: { http: 5000, health: 3000, ping: 5000, pty: 5000, workspace: 5000, shellInit: 3000, wakeRetry: 500, wakeVerify: 3000, wsIdleSec: 60 } as const,
  limits: { feedMax: 500, feedDefault: 50, feedHistory: 50, logsMax: 500, logsDefault: 50, logsTruncate: 500, messageTruncate: 100, ptyCols: 500, ptyRows: 200, maxConcurrentAgents: 40, peerProbeRetries: 2 } as const,
  inputGuard: { enabled: true, sweepIntervalMs: 5_000, stallNotifyMs: 180_000 } as const,
  hmacWindowSeconds: 300,
} as const;
