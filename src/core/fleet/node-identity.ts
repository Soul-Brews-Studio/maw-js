export interface CanonicalNodeIdentityInput {
  host: string;
  user?: string | null;
}

export interface ResolveNodeIdentityInput extends CanonicalNodeIdentityInput {
  port?: number;
}

export interface ResolvedNodeIdentity {
  node: string;
  host: string;
  user?: string;
  port?: number;
}

export type NodeIdentityConfig = {
  node?: string;
  port?: number;
  nodeUser?: string;
  serviceUser?: string;
};

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Canonical service identity for federation-visible nodes (#1814).
 *
 * Single-service hosts keep the historical host identity. Multi-user services
 * on one host can add a user prefix (`alpha@white`) so federation status does
 * not collapse distinct maw-server instances that share the same machine.
 */
export function canonicalNodeIdentity(input: CanonicalNodeIdentityInput): string {
  const host = clean(input.host) ?? "local";
  if (host.includes("@")) return host;
  const user = clean(input.user);
  if (!user || user === host) return host;
  return `${user}@${host}`;
}

export function resolveNodeIdentity(
  config: NodeIdentityConfig,
  opts: { fallbackHost?: string; env?: Record<string, string | undefined>; user?: string } = {},
): ResolvedNodeIdentity {
  const host = clean(config.node) ?? clean(opts.fallbackHost) ?? "local";
  const env = opts.env ?? process.env;
  const explicitUser = clean(config.nodeUser) ?? clean(config.serviceUser) ?? clean(env.MAW_NODE_USER) ?? clean(env.MAW_SERVICE_USER);
  const port = Number.isInteger(config.port) ? config.port : undefined;
  const inferredUser = explicitUser ?? (port !== undefined && port !== 3456 ? clean(opts.user) : undefined);
  const node = canonicalNodeIdentity({ host, user: inferredUser });
  return {
    node,
    host,
    ...(inferredUser && node !== host ? { user: inferredUser } : {}),
    ...(port !== undefined ? { port } : {}),
  };
}
