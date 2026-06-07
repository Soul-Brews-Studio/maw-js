import { Elysia } from "elysia";
import { loadConfig } from "../../../config";
import { hostedAgents as defaultHostedAgents } from "../../../commands/shared/federation-sync";
import { getPeerKey } from "../../../lib/peer-key";
import { resolveNodeIdentity } from "../../../core/fleet/node-identity";

/**
 * Endpoints advertised by /api/identity (#804 Step 1).
 *
 * Lets peers discover supported API surfaces in one round-trip instead of
 * probing each path individually. Keep alphabetised + in sync with the actual
 * mounted routes — this is a contract, not documentation.
 */
export const ADVERTISED_ENDPOINTS: string[] = [
  "/api/agents",
  "/api/identity",
  "/api/messages",
  "/api/pane-keys",
  "/api/probe",
  "/api/send",
  "/api/sleep",
  "/api/wake",
];

export interface IdentityApiDeps {
  loadConfig?: typeof loadConfig;
  hostedAgents?: typeof defaultHostedAgents;
  getPeerKey?: typeof getPeerKey;
  packageVersion?: string;
  uptime?: () => number;
  nowIso?: () => string;
}

export function createIdentityApi(deps: IdentityApiDeps = {}) {
  const load = deps.loadConfig ?? loadConfig;
  const agentsForHost = deps.hostedAgents ?? defaultHostedAgents;
  const peerKey = deps.getPeerKey ?? getPeerKey;
  const version = deps.packageVersion ?? require("../../../../package.json").version;
  const uptime = deps.uptime ?? (() => process.uptime());
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());

  const identityApi = new Elysia();

  /**
   * Node identity — public endpoint for federation dedup (#192) + clock health (#268).
   *
   * #804 Step 1 (ADR docs/federation/0001-peer-identity.md): also advertises
   *   - `endpoints`: supported API paths so peers can discover capabilities
   *     in one round-trip (closes the version-skew pressure).
   *   - `pubkey`: per-peer identity for TOFU pinning + Step 4 signing. Persisted
   *     at <CONFIG_DIR>/peer-key (SSH host-key model).
   */
  identityApi.get("/identity", async () => {
    const config = load();
    const identity = resolveNodeIdentity(config, {
      fallbackHost: "local",
      user: process.env.USER || process.env.LOGNAME,
    });
    const node = identity.node;
    const host = identity.host;
    const oracle = config.oracle ?? "mawjs";
    const agents = [...new Set([
      ...agentsForHost(config.agents || {}, node),
      ...(host !== node ? agentsForHost(config.agents || {}, host) : []),
    ])];
    return {
      node,
      host,
      ...(identity.user ? { user: identity.user } : {}),
      ...(identity.port !== undefined ? { port: identity.port } : {}),
      oracle,
      version,
      agents,
      uptime: Math.floor(uptime()),
      clockUtc: nowIso(),
      endpoints: ADVERTISED_ENDPOINTS,
      pubkey: peerKey(),
    };
  });

  return identityApi;
}
