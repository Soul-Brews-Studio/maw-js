/**
 * TypeBox schemas for core API types.
 *
 * Phase 1 of Hono -> Elysia migration (#306).
 * These schemas serve double duty:
 *   1. Runtime validation of request bodies (via validate.ts middleware)
 *   2. Static type inference (via Static<typeof Schema>)
 *
 * When we move to Elysia, these translate directly to t.Object() etc.
 */

import { Type, type Static } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Response schemas (GET endpoints)
// ---------------------------------------------------------------------------

export const Identity = Type.Object({
  node: Type.String(),
  version: Type.String(),
  agents: Type.Array(Type.String()),
  clockUtc: Type.String(),
  uptime: Type.Number(),
  // #804 Step 1 — federation peer identity (ADR docs/federation/0001-peer-identity.md).
  // `endpoints` lets peers discover supported API surfaces in one round-trip;
  // `pubkey` is the per-peer identity used for TOFU pinning + future signing.
  endpoints: Type.Array(Type.String()),
  pubkey: Type.String(),
});
export type TIdentity = Static<typeof Identity>;

export const Peer = Type.Object({
  url: Type.String(),
  reachable: Type.Boolean(),
  latency: Type.Optional(Type.Number()),
  node: Type.Optional(Type.String()),
  agents: Type.Optional(Type.Array(Type.String())),
  clockDeltaMs: Type.Optional(Type.Number()),
  clockWarning: Type.Optional(Type.Boolean()),
});
export type TPeer = Static<typeof Peer>;

export const FederationStatus = Type.Object({
  localUrl: Type.String(),
  peers: Type.Array(Peer),
  totalPeers: Type.Number(),
  reachablePeers: Type.Number(),
  clockHealth: Type.Optional(
    Type.Object({
      clockUtc: Type.String(),
      timezone: Type.String(),
      uptimeSeconds: Type.Number(),
    }),
  ),
});
export type TFederationStatus = Static<typeof FederationStatus>;

export const Session = Type.Object({
  name: Type.String(),
  source: Type.Optional(Type.String()),
  windows: Type.Array(
    Type.Object({
      index: Type.Number(),
      name: Type.String(),
      active: Type.Boolean(),
    }),
  ),
});
export type TSession = Static<typeof Session>;

export const FeedEvent = Type.Object({
  timestamp: Type.String(),
  oracle: Type.String(),
  host: Type.String(),
  event: Type.String(),
  project: Type.String(),
  sessionId: Type.String(),
  message: Type.String(),
});
export type TFeedEvent = Static<typeof FeedEvent>;

export const PluginInfo = Type.Object({
  name: Type.String(),
  type: Type.String(),
  source: Type.String(),
  loadedAt: Type.String(),
  events: Type.Number(),
  errors: Type.Number(),
});
export type TPluginInfo = Static<typeof PluginInfo>;

// ---------------------------------------------------------------------------
// Request body schemas (POST endpoints)
// ---------------------------------------------------------------------------

/** POST /api/wake — accepts `target` (current) or `oracle` (legacy pre-rename) */
export const WakeBody = Type.Object({
  target: Type.Optional(Type.String()),
  oracle: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
});
export type TWakeBody = Static<typeof WakeBody>;

/** POST /api/sleep */
export const SleepBody = Type.Object({
  target: Type.String(),
});
export type TSleepBody = Static<typeof SleepBody>;

/**
 * POST /api/probe (#804 Step 5).
 *
 * Real-write-path health check: exercises the same resolution code path as
 * /api/send (resolveTarget + tmux session existence) without delivering. If
 * `target` is omitted, the server only confirms it can run the write code
 * path at all (process up + config readable). When `target` is supplied, the
 * server validates it resolves and reports the transport that would be used.
 *
 * Why a dedicated probe (vs. reusing /api/identity)? The two endpoints take
 * disjoint code paths — /api/identity reads package.json + peer-key and
 * passes through near-zero handler logic, so it can answer 200 OK while
 * /api/send is broken (the schema-drift incident on #795 was exactly this).
 * /api/probe shares the actual write-path branches so a "green" probe means
 * the receiver can deliver, not just that its HTTP server is alive.
 */
export const ProbeBody = Type.Object({
  target: Type.Optional(Type.String()),
});
export type TProbeBody = Static<typeof ProbeBody>;

/** POST /api/send */
export const SendBody = Type.Object({
  target: Type.String(),
  text: Type.String(),
  force: Type.Optional(Type.Boolean()),
  attachments: Type.Optional(Type.Array(Type.String())),
});
export type TSendBody = Static<typeof SendBody>;

/**
 * POST /api/pane-keys (#757)
 *
 * Raw tmux send-keys to any pane (bash, claude, anything). No paste-mode,
 * no readiness guard. Used by `maw send` (enter=false) and `maw run`
 * (enter=true) for cross-node pane control.
 */
export const PaneKeysBody = Type.Object({
  target: Type.String(),
  text: Type.String(),
  enter: Type.Optional(Type.Boolean()),
});
export type TPaneKeysBody = Static<typeof PaneKeysBody>;

/** POST /api/config-file (save) */
export const ConfigFileBody = Type.Object({
  content: Type.String(),
});
export type TConfigFileBody = Static<typeof ConfigFileBody>;

/** POST /api/triggers/fire */
export const TriggerFireBody = Type.Object({
  event: Type.String(),
  context: Type.Optional(
    Type.Record(Type.String(), Type.Optional(Type.String())),
  ),
});
export type TTriggerFireBody = Static<typeof TriggerFireBody>;

/** POST /api/transport/send */
export const TransportSendBody = Type.Object({
  oracle: Type.String(),
  message: Type.String(),
  host: Type.Optional(Type.String()),
  from: Type.Optional(Type.String()),
});
export type TTransportSendBody = Static<typeof TransportSendBody>;
