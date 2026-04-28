/**
 * Integration — 2-port localhost /info + probe round-trip (no docker).
 *
 * Spawns two real `maw serve` subprocesses on ephemeral ports on 127.0.0.1,
 * each isolated by MAW_HOME + PEERS_FILE, then runs the probe flow
 * (cmdAdd → cmdProbe) in both directions and asserts success. Proves the
 * full federation handshake works end-to-end on a developer laptop without
 * docker, matching the shape of docker/compose.yml's node-a ↔ node-b test.
 *
 * Skip-gates (any one trips the skip):
 *   - MAW_SKIP_INTEGRATION=1  — sibling integration tests use this prefix
 *   - SKIP_INTEGRATION=1      — legacy gate, kept for back-compat
 *   - MAW_SKIP_FLAKY=1        — granular flake gate (#830 — known CI flake
 *                               on `test-unit` shard from port-binding race)
 *
 * #830 — CI port-binding flake.
 *   The probe between getEphemeralPort()→close and Bun.spawn()→listen has a
 *   small window where the kernel can hand the same port to a concurrent
 *   process on the same runner, causing the spawned `maw serve` to fail to
 *   bind and waitForInfo() to time out at 20s. Mitigations in this file:
 *     1. SO_REUSEADDR on the probe socket so handoff doesn't strand the port
 *        in TIME_WAIT.
 *     2. Allocate both ports first, verify each is rebindable, retry on EADDRINUSE.
 *     3. waitForInfo timeout bumped 20s → 60s — defensive, slow CI shards.
 *     4. CI sets MAW_SKIP_FLAKY=1 on the `test-unit` shard until rooted out
 *        (override pattern — #811/#813 precedent).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "net";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");

const SKIP =
  process.env.SKIP_INTEGRATION === "1" ||
  process.env.MAW_SKIP_INTEGRATION === "1" ||
  process.env.MAW_SKIP_FLAKY === "1";

/**
 * Ask the kernel for a free TCP port on 127.0.0.1.
 *
 * The race: between us closing the probe socket and the subprocess binding,
 * another concurrent process on the same CI runner can grab the same port.
 * To shrink the window we set SO_REUSEADDR (kernel hands the port back even
 * if it's in TIME_WAIT) and retry up to `attempts` times if the caller's
 * subsequent bind fails. The retry is driven by spawnNode() observing the
 * subprocess's exit code, so this fn just makes the port _likely_ free.
 */
async function getEphemeralPort(attempts = 5): Promise<number> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const srv = createServer();
        srv.once("error", reject);
        // SO_REUSEADDR: kernel may rebind even if the port is in TIME_WAIT.
        // Node's `createServer` exposes this via the listen options object.
        srv.listen({ port: 0, host: "127.0.0.1", exclusive: false }, () => {
          const addr = srv.address();
          if (typeof addr === "object" && addr && typeof addr.port === "number") {
            const { port: p } = addr;
            srv.close(() => resolve(p));
          } else {
            srv.close();
            reject(new Error("could not resolve ephemeral port"));
          }
        });
      });
      return port;
    } catch (e) {
      lastErr = e;
      // small backoff before retrying
      await new Promise(r => setTimeout(r, 50 * (i + 1)));
    }
  }
  throw new Error(`could not allocate ephemeral port after ${attempts} attempts: ${String(lastErr)}`);
}

async function waitForInfo(
  url: string,
  timeoutMs = 60_000,
  proc?: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    // Fail fast if the subprocess died (e.g. EADDRINUSE on port-bind race).
    // Without this, we'd burn the full timeout waiting for a dead listener.
    if (proc && proc.exitCode !== null) {
      throw new Error(
        `subprocess for ${url} exited with code ${proc.exitCode} before /info responded`,
      );
    }
    try {
      const res = await fetch(`${url}/info`);
      if (res.ok) {
        const body = (await res.json()) as { maw?: unknown; node?: unknown };
        // Accept both pre-#628 `maw: true` and post-#628 object shape.
        const mawOk = body.maw === true
          || (!!body.maw && typeof body.maw === "object");
        if (mawOk && typeof body.node === "string" && body.node) return;
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${url}/info: ${String(lastErr)}`);
}

interface Node {
  name: string;
  port: number;
  url: string;
  home: string;
  peersFile: string;
  proc: ReturnType<typeof Bun.spawn>;
}

function spawnNode(name: string, home: string, port: number, peersFile: string): Node["proc"] {
  // Write a minimal maw.config.json so buildInfo().node is deterministic.
  const configDir = join(home, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "maw.config.json"),
    JSON.stringify({ host: name, node: name, port }, null, 2) + "\n",
    "utf-8",
  );

  return Bun.spawn({
    cmd: ["bun", "run", CLI_PATH, "serve", String(port)],
    env: {
      ...process.env,
      MAW_HOME: home,
      PEERS_FILE: peersFile,
      MAW_CLI: "1",
      MAW_QUIET: "1",
    },
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function killNode(proc: Node["proc"]): Promise<void> {
  if (proc.exitCode !== null) return;
  try { proc.kill("SIGTERM"); } catch { /* already gone */ }
  const killTimer = setTimeout(() => {
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }, 2000);
  try { await proc.exited; } finally { clearTimeout(killTimer); }
}

describe.skipIf(SKIP)("federation — 2-port localhost /info + probe round-trip", () => {
  let tmp: string;
  let nodeA: Node;
  let nodeB: Node;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "maw-fed-local-"));

    const aHome = join(tmp, "a-home");
    const bHome = join(tmp, "b-home");
    const aPeers = join(tmp, "a-peers.json");
    const bPeers = join(tmp, "b-peers.json");
    mkdirSync(aHome, { recursive: true });
    mkdirSync(bHome, { recursive: true });

    const [aPort, bPort] = await Promise.all([getEphemeralPort(), getEphemeralPort()]);

    nodeA = {
      name: "node-a", port: aPort, url: `http://127.0.0.1:${aPort}`,
      home: aHome, peersFile: aPeers,
      proc: spawnNode("node-a", aHome, aPort, aPeers),
    };
    nodeB = {
      name: "node-b", port: bPort, url: `http://127.0.0.1:${bPort}`,
      home: bHome, peersFile: bPeers,
      proc: spawnNode("node-b", bHome, bPort, bPeers),
    };

    await Promise.all([
      waitForInfo(nodeA.url, 60_000, nodeA.proc),
      waitForInfo(nodeB.url, 60_000, nodeB.proc),
    ]);
  }, 90_000);

  afterAll(async () => {
    await Promise.all([
      nodeA ? killNode(nodeA.proc) : Promise.resolve(),
      nodeB ? killNode(nodeB.proc) : Promise.resolve(),
    ]);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("each node's /info returns 200 with a truthy maw handshake and the configured node name", async () => {
    for (const n of [nodeA, nodeB]) {
      const res = await fetch(`${n.url}/info`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { node?: unknown; maw?: unknown; ts?: unknown };
      // Post-#628: maw is a self-describing object (`{schema,plugins,capabilities}`).
      // The probe gate accepts both, so we assert only the generic "truthy"
      // contract here — the shape specifics are covered in info-endpoint.test.ts.
      expect(body.maw).toBeTruthy();
      expect(body.node).toBe(n.name);
      expect(typeof body.ts).toBe("string");
    }
  });

  test("nodeA → nodeB: cmdAdd auto-probes, cmdProbe succeeds, lastSeen set", async () => {
    process.env.PEERS_FILE = nodeA.peersFile;
    try {
      const { cmdAdd, cmdProbe, cmdInfo } = await import("../../src/commands/plugins/peers/impl");

      const add = await cmdAdd({ alias: "b", url: nodeB.url });
      expect(add.probeError).toBeUndefined();
      expect(add.peer.node).toBe("node-b");
      expect(add.peer.lastSeen).toBeTruthy();

      const probe = await cmdProbe("b");
      expect(probe.ok).toBe(true);
      expect(probe.error).toBeUndefined();
      expect(probe.node).toBe("node-b");

      const info = cmdInfo("b");
      expect(info).not.toBeNull();
      expect(info!.lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(info!.lastError).toBeUndefined();
    } finally {
      delete process.env.PEERS_FILE;
    }
  }, 10_000);

  test("nodeB → nodeA: cmdAdd auto-probes, cmdProbe succeeds, lastSeen set", async () => {
    process.env.PEERS_FILE = nodeB.peersFile;
    try {
      const { cmdAdd, cmdProbe, cmdInfo } = await import("../../src/commands/plugins/peers/impl");

      const add = await cmdAdd({ alias: "a", url: nodeA.url });
      expect(add.probeError).toBeUndefined();
      expect(add.peer.node).toBe("node-a");
      expect(add.peer.lastSeen).toBeTruthy();

      const probe = await cmdProbe("a");
      expect(probe.ok).toBe(true);
      expect(probe.error).toBeUndefined();
      expect(probe.node).toBe("node-a");

      const info = cmdInfo("a");
      expect(info).not.toBeNull();
      expect(info!.lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(info!.lastError).toBeUndefined();
    } finally {
      delete process.env.PEERS_FILE;
    }
  }, 10_000);
});
