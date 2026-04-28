export type TriggerEvent = "issue-close" | "pr-merge" | "agent-idle" | "agent-wake" | "agent-crash" | "cron";

export interface TriggerConfig {
  on: TriggerEvent;
  repo?: string;       // filter by repo (for issue-close, pr-merge)
  timeout?: number;     // seconds (for agent-idle)
  schedule?: string;    // crontab expression (for cron) — 5-field "m h dom mon dow"
  action: string;       // shell command to execute — supports {agent}, {repo}, {issue} templates
  name?: string;        // optional human label
  once?: boolean;       // fire once then self-destruct (#149)
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
  /** Polling intervals (ms) */
  intervals?: MawIntervals;
  /** HTTP/operation timeouts (ms) */
  timeouts?: MawTimeouts;
  /** Buffer/display limits */
  limits?: MawLimits;
  /** HMAC auth window (seconds) */
  hmacWindowSeconds?: number;
  /** PIN for web UI */
  pin?: string;
  /** Plugin source URLs — auto-installed on bootstrap (nuke → first run) */
  pluginSources?: string[];
  /** Plugin names to disable (skip during scanning and execution) */
  disabledPlugins?: string[];
}

/** Typed defaults for intervals, timeouts, limits (#172) */
export const D = {
  intervals: { capture: 50, sessions: 5000, status: 3000, teams: 3000, preview: 2000, peerFetch: 10000, crashCheck: 30000 } as const,
  timeouts: { http: 5000, health: 3000, ping: 5000, pty: 5000, workspace: 5000, shellInit: 3000, wakeRetry: 500, wakeVerify: 3000 } as const,
  limits: { feedMax: 500, feedDefault: 50, feedHistory: 50, logsMax: 500, logsDefault: 50, logsTruncate: 500, messageTruncate: 100, ptyCols: 500, ptyRows: 200 } as const,
  hmacWindowSeconds: 300,
} as const;
