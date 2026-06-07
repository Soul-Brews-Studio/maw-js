import { getFederationStatus, getTransportRouter } from "maw-js/sdk";
import type { ServeHttpRouteRegistrar } from "maw-js/plugin/types";

type DiscoveredPeer = {
  zid: string;
  node: string;
  oracle: string;
  host: string;
  locators: string[];
  capabilities: string[];
  oracles: string[];
  lastSeen: number;
  paired: boolean;
};

type DiscoveryRow = {
  zid: string;
  node: string;
  oracle: string;
  host: string;
  locators: string[];
  capabilities: string[];
  oracles: string[];
  firstSeen: string;
  lastSeen: string;
  seenRel: string;
  paired: boolean;
};

type DiscoveryResponse = {
  ok: true;
  total: number;
  shown: number;
  filtered: boolean;
  peers: DiscoveryRow[];
};

type ServeFederationDeps = {
  getFederationStatus: typeof getFederationStatus;
  listDiscoveredPeers: () => DiscoveredPeer[];
  now: () => number;
};

type ServeFederationContext = {
  http?: ServeHttpRouteRegistrar;
};

const defaultDeps: ServeFederationDeps = {
  getFederationStatus,
  listDiscoveredPeers: () => getTransportRouter().listDiscoveredPeers() as DiscoveredPeer[],
  now: () => Date.now(),
};

function relativeSeen(deltaMs: number): string {
  const seconds = Math.max(0, Math.floor(deltaMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function toDiscoveryResponse(
  peers: DiscoveredPeer[],
  opts: { all?: boolean; limit?: number; now?: number } = {},
): DiscoveryResponse {
  const now = opts.now ?? Date.now();
  const filtered = opts.all ? peers : peers.filter((p) => !p.paired);
  const sorted = filtered
    .slice()
    .sort((a, b) => b.lastSeen - a.lastSeen || a.node.localeCompare(b.node));
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 50;
  const shown = sorted.slice(0, limit);
  return {
    ok: true,
    total: sorted.length,
    shown: shown.length,
    filtered: !opts.all,
    peers: shown.map((p) => ({
      zid: p.zid,
      node: p.node,
      oracle: p.oracle,
      host: p.host,
      locators: p.locators,
      capabilities: p.capabilities,
      oracles: p.oracles,
      firstSeen: new Date(p.lastSeen).toISOString(),
      lastSeen: new Date(p.lastSeen).toISOString(),
      seenRel: relativeSeen(now - p.lastSeen),
      paired: p.paired,
    })),
  };
}

export function createFederationRouteHandlers(deps: ServeFederationDeps = defaultDeps) {
  return {
    status: async () => Response.json(await deps.getFederationStatus()),
    discoveries: async (request: Request) => {
      const url = new URL(request.url);
      const allParam = url.searchParams.get("all");
      const limitParam = url.searchParams.get("limit");
      const all = allParam === "1" || allParam === "true";
      const limit = limitParam === null ? undefined : Number(limitParam);
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        return Response.json({
          ok: false,
          error: "invalid_limit",
          hint: "limit must be a positive number",
        }, { status: 400 });
      }
      return Response.json(toDiscoveryResponse(deps.listDiscoveredPeers(), { all, limit, now: deps.now() }));
    },
  };
}

export function registerFederationRoutes(http: ServeHttpRouteRegistrar, deps?: ServeFederationDeps): void {
  const handlers = createFederationRouteHandlers(deps);
  http.route("GET", "/api/federation/status", handlers.status);
  http.route("GET", "/api/peers/discoveries", handlers.discoveries);
  http.route("GET", "/api/peers/discovered", handlers.discoveries);
}

export function serve(ctx: ServeFederationContext): void {
  if (!ctx.http) throw new Error("serve-federation requires serve http route registration");
  registerFederationRoutes(ctx.http);
}

export default serve;
