/**
 * fedtest — backend interface (#655 Phase 1).
 *
 * Both EmulatedBackend (in-process Bun.serve) and DockerBackend (wrapped
 * compose stack) implement this contract so scenarios can run against
 * either without branching. Phase 1 keeps PeerHandle intentionally small
 * — richer mutation hooks (setSlow/setOffline/spoofSha) land in later
 * phases as scenarios demand them, not speculatively.
 */

export type BackendName = "emulated" | "docker";

export interface PeerHandle {
  /** Base URL (no trailing slash). Reachable from the test process. */
  url: string;
  /** Node identity as reported by this peer's /info body.node. */
  node: string;
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
