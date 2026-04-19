/**
 * Integration — 2-port localhost /info + probe round-trip (no docker).
 *
 * Spawns two real `maw serve` subprocesses on ephemeral ports on 127.0.0.1,
 * each isolated by MAW_HOME + PEERS_FILE, then runs the probe flow
 * (cmdAdd → cmdProbe) in both directions and asserts success. Proves the
 * full federation handshake works end-to-end on a developer laptop without
 * docker, matching the shape of docker/compose.yml's node-a ↔ node-b test.
 *
 * Skip-gate: set SKIP_INTEGRATION=1 for CI variants that cannot spawn bun
 * subprocesses (e.g. sandboxed runners).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "net";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");

const SKIP = process.env.SKIP_INTEGRATION === "1";

async function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr && typeof addr.port === "number") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not resolve ephemeral port"));
      }
    });
  });
}

async function waitForInfo(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/info`);
      if (res.ok) {
        const body = (await res.json()) as { maw?: unknown; node?: unknown };
        if (body.maw === true && typeof body.node === "string" && body.node) return;
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

    await Promise.all([waitForInfo(nodeA.url), waitForInfo(nodeB.url)]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([
      nodeA ? killNode(nodeA.proc) : Promise.resolve(),
      nodeB ? killNode(nodeB.proc) : Promise.resolve(),
    ]);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("each node's /info returns 200 with maw:true and the configured node name", async () => {
    for (const n of [nodeA, nodeB]) {
      const res = await fetch(`${n.url}/info`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { node?: unknown; maw?: unknown; ts?: unknown };
      expect(body.maw).toBe(true);
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
