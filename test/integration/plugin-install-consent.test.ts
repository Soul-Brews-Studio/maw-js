/**
 * @peer install + consent gate — 2-port integration demo (#644 Phase 3).
 *
 * Variant of plugin-install-at-peer.test.ts that drives the PIN-consent
 * flow end-to-end:
 *
 *   1. Untrusted pair — gate blocks, PIN surfaced, pending mirror written
 *      locally + peer received the /api/consent/request POST.
 *   2. After recording a trust entry for myNode → peerNode : plugin-install,
 *      the gate allows and the real install proceeds.
 *
 * Hermetic: MAW_PLUGINS_DIR, MAW_PLUGINS_LOCK, CONSENT_TRUST_FILE,
 * CONSENT_PENDING_DIR all redirect to a per-test tmpdir.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
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
import { maybeGatePluginInstall } from "../../src/core/consent/gate-plugin-install";
import { listPending, recordTrust } from "../../src/core/consent";
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

function buildFakePlugin(root: string, name: string, version: string): { sha256: string } {
  mkdirSync(root, { recursive: true });
  const artifactRel = "dist/index.js";
  const artifactAbs = join(root, artifactRel);
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    artifactAbs,
    `// Fake built plugin for consent integration test.\nexport default { name: ${JSON.stringify(name)} };\n`,
  );
  const sha256 = sha256File(artifactAbs);
  const manifest = {
    name,
    version,
    sdk: runtimeSdkVersion(),
    description: "Integration-test plugin for #644 Phase 3",
    artifact: { path: artifactRel, sha256 },
  };
  writeFileSync(join(root, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { sha256 };
}

/**
 * Peer server that additionally accepts POST /api/consent/request so the
 * gate's request-consent HTTP call succeeds against real bytes.
 */
function startPeerServer(opts: {
  node: string;
  plugins: Array<{ name: string; version: string; sha256: string; dir: string }>;
  receivedConsent: Array<unknown>;
}) {
  const byName = new Map(opts.plugins.map(p => [p.name, p]));
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req: Request) {
      const url = new URL(req.url);

      if (url.pathname === "/api/consent/request" && req.method === "POST") {
        try {
          opts.receivedConsent.push(await req.json());
        } catch {
          opts.receivedConsent.push({ error: "malformed body" });
        }
        return new Response(null, { status: 201 });
      }

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

describe.skipIf(SKIP)("plugin install — @peer + consent gate (#644 Phase 3)", () => {
  let workRoot: string;
  let pluginSrc: string;
  let pluginsDir: string;
  let lockFile: string;
  let trustFile: string;
  let pendingDirPath: string;
  let peer: ReturnType<typeof startPeerServer>;
  let pluginSha: string;
  let receivedConsent: Array<unknown>;
  const pluginName = "integ-consent-ping";
  const pluginVersion = "1.0.0";
  const myNode = "client-node";
  const peerNode = "peer-alpha";

  const prev = {
    pluginsDir: process.env.MAW_PLUGINS_DIR,
    lock: process.env.MAW_PLUGINS_LOCK,
    trust: process.env.CONSENT_TRUST_FILE,
    pending: process.env.CONSENT_PENDING_DIR,
  };

  beforeAll(() => {
    workRoot = mkdtempSync(join(tmpdir(), "maw-consent-install-"));
    pluginSrc = join(workRoot, "src-plugin");
    pluginsDir = join(workRoot, "client-plugins");
    lockFile = join(workRoot, "plugins.lock");
    trustFile = join(workRoot, "trust.json");
    pendingDirPath = join(workRoot, "consent-pending");
    mkdirSync(pluginsDir, { recursive: true });

    const { sha256 } = buildFakePlugin(pluginSrc, pluginName, pluginVersion);
    pluginSha = sha256;

    receivedConsent = [];
    peer = startPeerServer({
      node: peerNode,
      plugins: [{ name: pluginName, version: pluginVersion, sha256: pluginSha, dir: pluginSrc }],
      receivedConsent,
    });

    process.env.MAW_PLUGINS_DIR = pluginsDir;
    process.env.MAW_PLUGINS_LOCK = lockFile;
    process.env.CONSENT_TRUST_FILE = trustFile;
    process.env.CONSENT_PENDING_DIR = pendingDirPath;
  });

  afterAll(() => {
    peer.server.stop(true);
    rmSync(workRoot, { recursive: true, force: true });
    for (const [k, v] of [
      ["MAW_PLUGINS_DIR", prev.pluginsDir],
      ["MAW_PLUGINS_LOCK", prev.lock],
      ["CONSENT_TRUST_FILE", prev.trust],
      ["CONSENT_PENDING_DIR", prev.pending],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    // Reset consent state between cases so each test sees a clean store.
    rmSync(trustFile, { force: true });
    rmSync(pendingDirPath, { recursive: true, force: true });
    receivedConsent.length = 0;
  });

  it("gates untrusted install — denies, POSTs to peer, mirrors pending locally", async () => {
    const resolved = await resolvePeerInstall(pluginName, "alpha", {
      searchOpts: {
        peers: [{ url: peer.url, name: "alpha" }],
        fetch: rawFetch,
        noCache: true,
      },
    });

    const decision = await maybeGatePluginInstall({
      myNode,
      peerName: resolved.peerName,
      peerNode: resolved.peerNode,
      peerUrl: resolved.peerUrl,
      pluginName,
      pluginVersion: resolved.version,
      pluginSha256: resolved.peerSha256,
    });

    expect(decision.allow).toBe(false);
    expect(decision.exitCode).toBe(2);
    expect(decision.message).toContain("consent required");
    expect(decision.message).toContain(pluginName);
    expect(decision.message).toMatch(/[A-Z2-9]{6}/);

    // Peer received the POST (real HTTP, not injected).
    expect(receivedConsent.length).toBe(1);
    const body = receivedConsent[0] as { action: string; from: string; to: string };
    expect(body.action).toBe("plugin-install");
    expect(body.from).toBe(myNode);
    expect(body.to).toBe(peerNode);

    // Local pending mirror exists with matching action.
    const pending = listPending();
    expect(pending.length).toBe(1);
    expect(pending[0]!.action).toBe("plugin-install");

    // Plugin was NOT installed — gate short-circuited before download.
    expect(existsSync(join(pluginsDir, pluginName))).toBe(false);
  });

  it("bypasses gate for pre-approved trust entry, then installs normally", async () => {
    recordTrust({
      from: myNode,
      to: peerNode,
      action: "plugin-install",
      approvedAt: new Date().toISOString(),
      approvedBy: "human",
      requestId: null,
    });

    const resolved = await resolvePeerInstall(pluginName, "alpha", {
      searchOpts: {
        peers: [{ url: peer.url, name: "alpha" }],
        fetch: rawFetch,
        noCache: true,
      },
    });

    const decision = await maybeGatePluginInstall({
      myNode,
      peerName: resolved.peerName,
      peerNode: resolved.peerNode,
      peerUrl: resolved.peerUrl,
      pluginName,
      pluginVersion: resolved.version,
      pluginSha256: resolved.peerSha256,
    });
    expect(decision.allow).toBe(true);

    // No consent POST, no pending mirror.
    expect(receivedConsent.length).toBe(0);
    expect(listPending().length).toBe(0);

    // Install proceeds end-to-end.
    await installFromUrl(resolved.downloadUrl, { pin: true, force: true });
    const installedManifestPath = join(pluginsDir, pluginName, "plugin.json");
    expect(existsSync(installedManifestPath)).toBe(true);
    const m = JSON.parse(readFileSync(installedManifestPath, "utf8"));
    expect(m.version).toBe(pluginVersion);
    expect(m.artifact.sha256).toBe(pluginSha);
  });
});
