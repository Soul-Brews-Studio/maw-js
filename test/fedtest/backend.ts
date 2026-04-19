/**
 * fedtest — backend interface (#655 Phase 1 + Phase 2 mutation API).
 *
 * Both EmulatedBackend (in-process Bun.serve) and DockerBackend (wrapped
 * compose stack) implement this contract so scenarios can run against
 * either without branching.
 *
 * Phase 2 adds a minimal mutation API to PeerHandle:
 *   • installPlugin  — advertise a plugin on this peer's list-manifest
 *   • setOffline     — simulate unreachable peer (stops/starts listener)
 *   • setSlow        — inject response delay (exercises timeout paths)
 *   • spoofSha       — override advertised sha256 (for adversarial tests)
 *
 * The emulated backend implements these in-process. Docker scenarios are
 * deferred to Phase 3 — the docker backend throws on mutation calls, and
 * scenarios that need mutations declare `backends: ["emulated"]`.
 */

export type BackendName = "emulated" | "docker";

/** A single peer advertised entry used by `/api/plugin/list-manifest`. */
export interface EmulatedPluginEntry {
  name: string;
  version: string;
  summary?: string;
  author?: string;
  /** Raw tarball bytes served by `/api/plugin/download/:name`. Optional. */
  tarball?: Uint8Array;
  /** Advertised sha256. `spoofSha` overrides this value without touching `tarball`. */
  sha256?: string | null;
}

export interface PeerHandle {
  /** Base URL (no trailing slash). Reachable from the test process. */
  url: string;
  /** Node identity as reported by this peer's /info body.node. */
  node: string;

  /**
   * Advertise a plugin on this peer's `/api/plugin/list-manifest` and
   * make its tarball (if provided) downloadable at
   * `/api/plugin/download/<name>`.
   */
  installPlugin(entry: EmulatedPluginEntry): Promise<void>;

  /**
   * Simulate this peer going offline (connection refused). Pass `false`
   * to bring it back. Idempotent.
   */
  setOffline(offline: boolean): Promise<void>;

  /**
   * Inject a pre-response delay. Pass `null` (or 0) to clear. Applies to
   * every endpoint — callers tune `perPeerMs` / `totalMs` against this
   * to exercise slow-peer paths.
   */
  setSlow(delayMs: number | null): Promise<void>;

  /**
   * Override the sha256 advertised for a specific plugin without changing
   * the served tarball bytes. Simulates a peer that lies about hashes —
   * used by adversarial scenarios.
   */
  spoofSha(pluginName: string, sha256: string | null): Promise<void>;
}

export interface SetUpOpts {
  /** Number of peers to spin up. */
  peers: number;
  /** Optional fixed ports; omit to use ephemeral (port: 0). */
  ports?: number[];
}

export interface BaseFederationBackend {
  readonly name: BackendName;
  setUp(opts: SetUpOpts): Promise<PeerHandle[]>;
  teardown(): Promise<void>;
}
