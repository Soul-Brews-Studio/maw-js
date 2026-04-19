/**
 * fedtest — Scenario type + runner helper (#655 Phase 1).
 *
 * A Scenario is a declarative object with an assert() that both backends
 * can exercise. runScenario() handles setUp/teardown so individual
 * scenarios don't repeat the boilerplate.
 */

import type { BaseFederationBackend, BackendName, PeerHandle } from "./backend";

export interface Scenario {
  name: string;
  /** Backends this scenario supports. Default: both. */
  backends?: BackendName[];
  /** Number of peers to spin up. Default: 2. */
  peers?: number;
  /** Optional pre-assertion hook (e.g. install a plugin on peer 0). */
  setUp?(peers: PeerHandle[], backend: BaseFederationBackend): Promise<void>;
  /** The actual test. Throws → scenario failed. */
  assert(peers: PeerHandle[], backend: BaseFederationBackend): Promise<void>;
  /** Optional post-assertion cleanup. Backend.teardown() always runs. */
  teardown?(peers: PeerHandle[], backend: BaseFederationBackend): Promise<void>;
}

/**
 * Run one scenario against one backend. Caller is expected to wrap the
 * invocation in a `bun:test` `test()` so failures bubble up as normal
 * test failures.
 */
export async function runScenario(scenario: Scenario, backend: BaseFederationBackend): Promise<void> {
  if (scenario.backends && !scenario.backends.includes(backend.name)) {
    throw new Error(`scenario "${scenario.name}" does not support backend "${backend.name}"`);
  }
  const peers = await backend.setUp({ peers: scenario.peers ?? 2 });
  try {
    if (scenario.setUp) await scenario.setUp(peers, backend);
    await scenario.assert(peers, backend);
    if (scenario.teardown) await scenario.teardown(peers, backend);
  } finally {
    await backend.teardown();
  }
}
