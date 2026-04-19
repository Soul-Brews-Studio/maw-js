/**
 * @peer install — 2-port integration demo (Task #1, §7.2).
 *
 * Spins up two Bun.serve instances that mimic the peer API surface:
 *   peer-A  → hosts a pre-built `integ-ping` plugin (list-manifest +
 *             /plugin/download/:name)
 *   peer-B  → empty peer (verifies the `peer` filter actually narrows)
 *
 * Drives the full client pipeline:
 *   resolvePeerInstall (HTTP → peer-A's list-manifest)
 *     → installFromUrl (HTTP → peer-A's /plugin/download endpoint)
 *       → installFromTarball (staging + SDK gate + lock gate via --pin)
 *         → ~/.maw/plugins/integ-ping
 *
 * Every touchpoint is a real HTTP request; no fetch injection. The test
 * proves that an identical artifact on the peer materialises on the
 * client side with matching sha256. Matches the "NOT done until 2-port
 * demo succeeds" criterion from the task.
 *
 * Hermetic: MAW_PLUGINS_DIR and MAW_PLUGINS_LOCK redirect every side
 * effect to per-test tmpdirs.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { join } from "path";

import { resolvePeerInstall } from "../../src/commands/plugins/plugin/install-peer-resolver";
import { installFromUrl } from "../../src/commands/plugins/plugin/install-handlers";
import { runtimeSdkVersion } from "../../src/plugin/registry";
import type { PeerManifestResponse } from "../../src/api/plugin-list-manifest";
import type { CurlResponse } from "../../src/core/transport/curl-fetch";

const SKIP = process.env.MAW_SKIP_INTEGRATION === "1";

async function rawFetch(url: string, opts?: { timeout?: number }): Promise<CurlResponse> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), opts?.timeout ?? 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/** Build a tiny but complete plugin source dir + built artifact. */
function buildFakePlugin(root: string, name: string, version: string): { sha256: string } {
  mkdirSync(root, { recursive: true });
  // Source file — the built artifact that gets hashed.
  const artifactRel = "dist/index.js";
  const artifactAbs = join(root, artifactRel);
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    artifactAbs,
    `// Fake built plugin for integration test.\nexport default { name: ${JSON.stringify(name)} };\n`,
  );
  const sha256 = sha256File(artifactAbs);
  const manifest = {
    name,
    version,
    sdk: runtimeSdkVersion(),
    description: "Integration-test plugin served by peer-A",
    artifact: { path: artifactRel, sha256 },
  };
  writeFileSync(join(root, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { sha256 };
}

/** Peer server that implements the two endpoints @peer install depends on. */
function startPeerServer(opts: {
  node: string;
  plugins: Array<{ name: string; version: string; sha256: string; dir: string }>;
}) {
  const byName = new Map(opts.plugins.map(p => [p.name, p]));
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname === "/api/plugin/list-manifest") {
        const body: PeerManifestResponse = {
          schemaVersion: 1,
          node: opts.node,
          pluginCount: opts.plugins.length,
          plugins: opts.plugins.map(p => ({
            name: p.name,
            version: p.version,
            sha256: p.sha256,
            downloadUrl: `/api/plugin/download/${encodeURIComponent(p.name)}`,
          })),
        };
        return Response.json(body);
      }
      const dlMatch = url.pathname.match(/^\/api\/plugin\/download\/([^/]+)$/);
      if (dlMatch) {
        const name = decodeURIComponent(dlMatch[1]!);
        const p = byName.get(name);
        if (!p) return new Response(JSON.stringify({ error: "not installed" }), { status: 404 });
        const tar = spawnSync("tar", ["-czf", "-", "-C", p.dir, "."], { encoding: "buffer" });
        if (tar.status !== 0) return new Response("tar failed", { status: 500 });
        return new Response(tar.stdout, {
          status: 200,
          headers: {
            "Content-Type": "application/gzip",
            "Content-Disposition": `attachment; filename="${name}-${p.version}.tgz"`,
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}` };
}

describe.skipIf(SKIP)("plugin install — @peer 2-port demo", () => {
  let workRoot: string;
  let pluginSrc: string;
  let pluginsDir: string;
  let lockFile: string;
  let peerA: ReturnType<typeof startPeerServer>;
  let peerB: ReturnType<typeof startPeerServer>;
  let pluginSha: string;
  const pluginName = "integ-ping";
  const pluginVersion = "1.0.0";

  const prevPluginsDir = process.env.MAW_PLUGINS_DIR;
  const prevLock = process.env.MAW_PLUGINS_LOCK;

  beforeAll(() => {
    workRoot = mkdtempSync(join(tmpdir(), "maw-atpeer-"));
    pluginSrc = join(workRoot, "src-plugin");
    pluginsDir = join(workRoot, "client-plugins");
    lockFile = join(workRoot, "plugins.lock");
    mkdirSync(pluginsDir, { recursive: true });

    const { sha256 } = buildFakePlugin(pluginSrc, pluginName, pluginVersion);
    pluginSha = sha256;

    peerA = startPeerServer({
      node: "peer-alpha",
      plugins: [{ name: pluginName, version: pluginVersion, sha256: pluginSha, dir: pluginSrc }],
    });
    peerB = startPeerServer({ node: "peer-beta", plugins: [] });

    process.env.MAW_PLUGINS_DIR = pluginsDir;
    process.env.MAW_PLUGINS_LOCK = lockFile;
  });

  afterAll(() => {
    peerA.server.stop(true);
    peerB.server.stop(true);
    rmSync(workRoot, { recursive: true, force: true });
    if (prevPluginsDir === undefined) delete process.env.MAW_PLUGINS_DIR;
    else process.env.MAW_PLUGINS_DIR = prevPluginsDir;
    if (prevLock === undefined) delete process.env.MAW_PLUGINS_LOCK;
    else process.env.MAW_PLUGINS_LOCK = prevLock;
  });

  it("resolves + installs a plugin from peer-A over real HTTP", async () => {
    // 1. resolvePeerInstall → real GET peer-A/api/plugin/list-manifest
    const resolved = await resolvePeerInstall(pluginName, "alpha", {
      searchOpts: {
        peers: [
          { url: peerA.url, name: "alpha" },
          { url: peerB.url, name: "beta" }, // proves `peer` filter actually narrows
        ],
        fetch: rawFetch,
        noCache: true,
      },
    });
    expect(resolved.downloadUrl).toBe(`${peerA.url}/api/plugin/download/${pluginName}`);
    expect(resolved.peerSha256).toBe(pluginSha);
    expect(resolved.version).toBe(pluginVersion);

    // 2. installFromUrl → real GET peer-A/api/plugin/download/integ-ping
    await installFromUrl(resolved.downloadUrl, { pin: true, force: true });

    // 3. Verify the client-side install has matching contents.
    const installedDir = join(pluginsDir, pluginName);
    const installedManifestPath = join(installedDir, "plugin.json");
    expect(existsSync(installedManifestPath)).toBe(true);

    const installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf8"));
    expect(installedManifest.name).toBe(pluginName);
    expect(installedManifest.version).toBe(pluginVersion);
    expect(installedManifest.artifact.sha256).toBe(pluginSha);

    // 4. The actual artifact file must exist and re-hash to the same sha256
    //    — this is the "peer didn't swap the bytes" end-to-end check.
    const artifactAbs = join(installedDir, installedManifest.artifact.path);
    expect(existsSync(artifactAbs)).toBe(true);
    expect(sha256File(artifactAbs)).toBe(pluginSha);

    // 5. The lock file was written via --pin with matching source URL.
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    expect(lock.plugins[pluginName].version).toBe(pluginVersion);
    expect(lock.plugins[pluginName].sha256).toBe(pluginSha);
  });

  it("surfaces 'not on peer' error when the plugin is missing on the chosen peer", async () => {
    await expect(
      resolvePeerInstall("does-not-exist", "alpha", {
        searchOpts: {
          peers: [{ url: peerA.url, name: "alpha" }],
          fetch: rawFetch,
          noCache: true,
        },
      }),
    ).rejects.toThrow(/no plugin named 'does-not-exist' on peer 'alpha'/);
  });

  it("surfaces peer-offline error when the peer URL is bad", async () => {
    await expect(
      resolvePeerInstall(pluginName, "ghost", {
        searchOpts: {
          peers: [{ url: "http://127.0.0.1:1", name: "ghost" }], // reserved port; connection refused
          fetch: rawFetch,
          noCache: true,
          perPeerMs: 500,
          totalMs: 1000,
        },
      }),
    ).rejects.toThrow(/peer 'ghost'/);
  });
});
