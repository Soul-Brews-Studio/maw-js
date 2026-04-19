/**
 * Bind-host heuristic (#616).
 *
 * Decide between 0.0.0.0 (federation-exposed) and 127.0.0.1 (loopback only).
 * Returns both the hostname and the reason that triggered a non-loopback
 * bind (null when we stay on loopback) so the startup log can explain itself.
 *
 * Triggers for 0.0.0.0, in priority order:
 *   1. config.peers — legacy positional peers list
 *   2. config.namedPeers — newer named-peer list
 *   3. MAW_HOST === "0.0.0.0" — explicit env opt-in (docker / CI)
 *   4. ~/.maw/peers.json non-empty — federation runtime state (container
 *      entrypoints write this via `maw peers add` before `maw serve`)
 *
 * Env opt-in wins over the file check so tests don't have to touch disk;
 * passing a non-null PeersStoreReader lets tests inject a fake.
 *
 * Extracted into its own module (not src/core/server.ts) so tests can import
 * it without triggering server.ts's auto-start side effect.
 */
export type BindHostReason = "config.peers" | "config.namedPeers" | "MAW_HOST" | "peers.json" | null;

export interface BindConfig {
  peers?: unknown[] | null;
  namedPeers?: unknown[] | null;
}

export interface BindHostEnv {
  MAW_HOST?: string;
}

export type PeersStoreReader = () => { peers: Record<string, unknown> };

export function resolveBindHost(
  config: BindConfig,
  env: BindHostEnv = process.env,
  readPeers: PeersStoreReader | null = null,
): { hostname: string; reason: BindHostReason } {
  if ((config.peers?.length ?? 0) > 0) return { hostname: "0.0.0.0", reason: "config.peers" };
  if ((config.namedPeers?.length ?? 0) > 0) return { hostname: "0.0.0.0", reason: "config.namedPeers" };
  if (env.MAW_HOST === "0.0.0.0") return { hostname: "0.0.0.0", reason: "MAW_HOST" };
  const reader = readPeers ?? (() => {
    try {
      // Lazy-require to keep this heuristic importable without the plugin bundle.
      return require("../commands/plugins/peers/store").loadPeers();
    } catch { return { peers: {} }; }
  });
  try {
    const store = reader();
    if (store && Object.keys(store.peers ?? {}).length > 0) return { hostname: "0.0.0.0", reason: "peers.json" };
  } catch { /* ignore — stay on loopback */ }
  return { hostname: "127.0.0.1", reason: null };
}
