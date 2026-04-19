/**
 * fedtest — DockerBackend (#655 Phase 1).
 *
 * Thin wrapper around `scripts/test-docker-federation.sh` + the existing
 * `docker/compose.yml`. We do NOT rewrite the shipped shell harness (per
 * #655 open question 4) — that harness is what CI already exercises.
 *
 * Phase 1 limits:
 * - peers: 2 only (compose file is fixed at node-a + node-b)
 * - ports are the published host ports 13456/13457; `opts.ports` is
 *   rejected (can't remap without editing compose).
 *
 * Callers get a clean SKIP via `available()` when docker isn't on PATH —
 * matches the test/integration/* pattern used elsewhere in this repo.
 */

import type { BaseFederationBackend, EmulatedPluginEntry, PeerHandle, SetUpOpts } from "./backend";
import { spawnSync } from "child_process";

function mutationUnsupported(op: string): never {
  throw new Error(
    `DockerBackend Phase 1/2 does not support PeerHandle.${op}() — ` +
    `scenarios that mutate peer state must declare backends: ["emulated"]`,
  );
}

class DockerPeerHandle implements PeerHandle {
  constructor(readonly url: string, readonly node: string) {}
  installPlugin(_e: EmulatedPluginEntry): Promise<void> { return mutationUnsupported("installPlugin"); }
  setOffline(_o: boolean): Promise<void> { return mutationUnsupported("setOffline"); }
  setSlow(_d: number | null): Promise<void> { return mutationUnsupported("setSlow"); }
  spoofSha(_n: string, _s: string | null): Promise<void> { return mutationUnsupported("spoofSha"); }
}

const COMPOSE_FILE = "docker/compose.yml";
const HEALTHY_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

export class DockerBackend implements BaseFederationBackend {
  readonly name = "docker" as const;
  private brought = false;

  /** Returns true iff `docker` is runnable in this environment. */
  static available(): boolean {
    try {
      const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" });
      return r.status === 0;
    } catch { return false; }
  }

  async setUp(opts: SetUpOpts): Promise<PeerHandle[]> {
    if (opts.peers !== 2) throw new Error(`DockerBackend Phase 1 supports peers=2 only (got ${opts.peers})`);
    if (opts.ports) throw new Error("DockerBackend Phase 1 does not remap ports — omit opts.ports");

    const up = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d", "--build"], { stdio: "inherit" });
    if (up.status !== 0) throw new Error(`docker compose up failed (exit ${up.status})`);
    this.brought = true;

    await waitHealthy(HEALTHY_TIMEOUT_MS);

    return [
      new DockerPeerHandle("http://127.0.0.1:13456", "node-a"),
      new DockerPeerHandle("http://127.0.0.1:13457", "node-b"),
    ];
  }

  async teardown(): Promise<void> {
    if (!this.brought) return;
    spawnSync("docker", ["compose", "-f", COMPOSE_FILE, "down", "-v"], { stdio: "inherit" });
    this.brought = false;
  }
}

async function waitHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, "ps", "--format", "json"], { encoding: "utf-8" });
    if (r.status === 0 && r.stdout) {
      const lines = r.stdout.trim().split("\n").filter(Boolean);
      const healths: string[] = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as { Health?: string };
          healths.push(obj.Health ?? "none");
        } catch { /* ignore parse errors */ }
      }
      if (healths.length >= 2 && healths.every(h => h === "healthy")) return;
    }
    await new Promise(res => setTimeout(res, POLL_INTERVAL_MS));
  }
  throw new Error(`docker services did not reach healthy within ${timeoutMs}ms`);
}
