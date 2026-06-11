import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import type { Share } from "../../src/vendor/mpr-plugins/share/impl";

const realConfig = await import("../../src/config.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const resolvedTargets: string[] = [];

const configMock = {
  ...realConfig,
  loadConfig: () => ({ host: "local" }),
};
mock.module("maw-js/config", () => configMock);
mock.module(import.meta.resolve("../../src/config.ts"), () => configMock);

mock.module(import.meta.resolve("../../src/commands/plugins/tmux/impl"), () => ({
  resolveTmuxTarget: (target: string) => {
    resolvedTargets.push(target);
    if (target === "missing") return null;
    return { resolved: `${target}:resolved` };
  },
}));

const sharePlugin = await import("../../src/vendor/mpr-plugins/share/index.ts?plugin-share-standalone");
const shareImpl = await import("../../src/vendor/mpr-plugins/share/impl.ts?plugin-share-standalone");
const shareRuntimeImpl = await import("../../src/vendor/mpr-plugins/share/impl.ts");
const shareCrypto = await import("../../src/vendor/mpr-plugins/share/crypto.ts?plugin-share-standalone");
const shareStream = await import("../../src/vendor/mpr-plugins/share/stream.ts?plugin-share-standalone");
const shareHandler = sharePlugin.default;

beforeEach(() => {
  resolvedTargets.length = 0;
  shareImpl.clearShareRegistry();
  shareRuntimeImpl.clearShareRegistry();
  shareStream.__resetShareStreamBusesForTests();
});

function parseShareOutput(output: unknown, param = "t"): { slug: string; token: string } {
  const match = String(output).match(new RegExp(`/share/([^#]+)#${param}=(.+)$`));
  expect(match).toBeTruthy();
  return { slug: match![1]!, token: match![2]! };
}

function tamperHexDigest(hex: string): string {
  const replacement = hex.endsWith("0") ? "1" : "0";
  return `${hex.slice(0, -1)}${replacement}`;
}

async function makeServeHarness() {
  const httpRoutes: Array<{ method: string; path: string; handler: (req: Request) => Response | Promise<Response> }> = [];
  const wsRoutes: Array<{ path: string; data: (req: Request) => unknown; handlers: Record<string, unknown> }> = [];

  const result = await sharePlugin.serve({
    http: {
      route(method: string, path: string, handler: (req: Request) => Response | Promise<Response>) {
        httpRoutes.push({ method, path, handler });
      },
    },
    ws: {
      route(path: string, data: (req: Request) => unknown, handlers: Record<string, unknown>) {
        wsRoutes.push({ path, data, handlers });
      },
    },
  } as any);

  return { result, httpRoutes, wsRoutes };
}

describe("share plugin standalone boundary (#2685/#2703)", () => {
  test("share plugin import boundary stays explicit for standalone coverage gate", () => {
    expectStandalonePluginBoundary({
      plugin: "share",
      allowMawJs: ["maw-js/config"],
      allowRelative: [
        "../../../commands/plugins/tmux/impl",
        "../../../core/serve-route-registry",
        "../../../core/serve-ws-registry",
        "../../../lib/federation-auth",
        "../../../config",
      ],
    });
  });

  test("manifest-backed sources expose the CLI command and serve hook", () => {
    const manifest = JSON.parse(readFileSync(join(root, "src/vendor/mpr-plugins/share/plugin.json"), "utf8"));
    expect(manifest.name).toBe("share");
    expect(manifest.cli.command).toBe("share");
    expect(manifest.hooks.serve.handler).toBe("serve");

    const index = readFileSync(join(root, "src/vendor/mpr-plugins/share/index.ts"), "utf8");
    expect(index).toContain("export async function serve");
    expect(index).toContain("export default async function handler");

    const stream = readFileSync(join(root, "src/vendor/mpr-plugins/share/stream.ts"), "utf8");
    expect(stream).toContain('cmd: ["cat", path]');
    expect(stream).toContain('cmd: ["mkfifo", path]');
    expect(stream).toContain("cat > ${shellEscapeArg(fifoPath)}");
    expect(stream).not.toContain('cmd: ["tail"');
    expect(stream).not.toContain("cat >>");
    expect(stream).not.toContain("mkdtempSync");

    const viewer = readFileSync(join(root, "src/vendor/mpr-plugins/share/viewer.html"), "utf8");
    expect(viewer).toContain("const wsUrl = () =>");
    expect(viewer).toContain("resetForFreshSnapshot();");
    expect(viewer).toContain("term.reset();");
    expect(viewer).toContain("reconnectTimer = setTimeout(connect, delay);");
    expect(viewer).toContain("new window.FitAddon.FitAddon()");
    expect(viewer).toContain('window.addEventListener("resize", fitTerminal)');
    expect(viewer).toContain('window.visualViewport?.addEventListener("resize", fitTerminal)');
    expect(viewer).toContain("new ResizeObserver(fitTerminal)");
  });

  test("cli share dispatch posts to daemon and daemon serves minted viewer", async () => {
    const { httpRoutes } = await makeServeHarness();
    const createRoute = httpRoutes.find((route) => route.method === "POST" && route.path === "/api/share")!;
    const viewerRoute = httpRoutes.find((route) => route.method === "GET" && route.path === "/share/:slug")!;
    const metadataRoute = httpRoutes.find((route) => route.method === "GET" && route.path === "/api/share/:slug")!;
    const originalFetch = globalThis.fetch;
    const postedBodies: unknown[] = [];
    const postedUrls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      postedUrls.push(req.url);
      postedBodies.push(await req.clone().json());
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/api/share") {
        return createRoute.handler(req);
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const result = await shareHandler({
        source: "cli",
        args: ["neo:1", "--read-only", "--ttl", "42", "--port", "4567", "--auth", "token"],
      } as any);

      expect(result.ok).toBe(true);
      expect(resolvedTargets).toEqual(["neo:1"]);
      expect(postedUrls).toEqual(["http://127.0.0.1:4567/api/share"]);
      expect(postedBodies).toEqual([{ target: "neo:1:resolved", readOnly: true, ttl: 42, auth: "token" }]);
      expect(result.output).toMatch(/^http:\/\/local:4567\/share\/[a-z0-9]+#t=.+/);

      const { slug, token } = parseShareOutput(result.output);
      expect(slug).toMatch(/^[a-z0-9]+$/);
      expect(token.length).toBeGreaterThan(10);

      const viewer = await viewerRoute.handler(new Request(`http://127.0.0.1:4567/share/${slug}`));
      expect(viewer.status).toBe(200);

      const metadata = await metadataRoute.handler(new Request(`http://127.0.0.1:4567/api/share/${slug}?token=${encodeURIComponent(token)}`));
      expect(metadata.status).toBe(200);
      await expect(metadata.json()).resolves.toMatchObject({
        target: "neo:1:resolved",
        readOnly: true,
        auth: "token",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("crypto frames roundtrip and reject tamper or wrong key", () => {
    const secret = shareCrypto.mintShareSecret();
    const key = shareCrypto.deriveShareKey(secret);
    const plaintext = new TextEncoder().encode("hello encrypted pty\n");
    const frame = shareCrypto.encryptShareFrame(key, plaintext, 0n);

    expect(shareCrypto.isEncryptedShareFrame(frame)).toBe(true);
    expect(new TextDecoder().decode(shareCrypto.decryptShareFrame(key, frame))).toBe("hello encrypted pty\n");

    const tampered = new Uint8Array(frame);
    tampered[tampered.length - 17] ^= 0xff;
    expect(() => shareCrypto.decryptShareFrame(key, tampered)).toThrow();

    const wrongKey = shareCrypto.deriveShareKey(shareCrypto.mintShareSecret());
    expect(() => shareCrypto.decryptShareFrame(wrongKey, frame)).toThrow();
  });

  test("cli encrypted share mints on daemon and stream sends decryptable ciphertext only", async () => {
    const { httpRoutes } = await makeServeHarness();
    const createRoute = httpRoutes.find((route) => route.method === "POST" && route.path === "/api/share")!;
    const viewerRoute = httpRoutes.find((route) => route.method === "GET" && route.path === "/share/:slug")!;
    const originalFetch = globalThis.fetch;
    const postedBodies: unknown[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      postedBodies.push(await req.clone().json());
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/api/share") return createRoute.handler(req);
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const result = await shareHandler({
        source: "cli",
        args: ["neo:1", "--encrypt", "--ttl", "42", "--port", "4567"],
      } as any);

      expect(result.ok).toBe(true);
      expect(postedBodies).toEqual([{ target: "neo:1:resolved", readOnly: true, ttl: 42, auth: "encrypted", encrypted: true }]);
      expect(result.output).toMatch(/^http:\/\/local:4567\/share\/[a-z0-9]+#k=.+/);
      const { slug, token: secret } = parseShareOutput(result.output, "k");
      expect(secret.length).toBeGreaterThanOrEqual(43);

      const viewerSource = readFileSync(join(root, "src/vendor/mpr-plugins/share/viewer.html"), "utf8");
      const indexSource = readFileSync(join(root, "src/vendor/mpr-plugins/share/index.ts"), "utf8");
      expect(viewerSource).toContain("const e2eKey = params.get(\"k\") || \"\";");
      expect(viewerSource).toContain("const wsProof = e2eKey ? await sha256Hex(e2eKey) : token;");
      expect(viewerSource).toContain("?${e2eKey ? \"h\" : \"t\"}=");
      expect(viewerSource).not.toContain("?${e2eKey ? \"k\" : \"t\"}=");
      expect(viewerSource).not.toContain("const wsToken = e2eKey || token");
      expect(indexSource).not.toContain('searchParams.get("k")');

      const viewer = await viewerRoute.handler(new Request(`http://127.0.0.1:4567/share/${slug}`));
      expect(viewer.status).toBe(200);

      const share = shareRuntimeImpl.getShare(slug)!;
      expect(share).toMatchObject({ encrypted: true, auth: "encrypted" });
      expect(share.encryptionKeyHash).toBe(shareCrypto.hashShareSecret(secret));
      expect(share.encryptionKey).toBeTruthy();
      await expect(shareRuntimeImpl.verifyShare(slug, shareCrypto.hashShareSecret(secret))).resolves.toBe(true);
      await expect(shareRuntimeImpl.verifyShare(slug, tamperHexDigest(shareCrypto.hashShareSecret(secret)))).resolves.toBe(false);

      const sent: Array<string | Uint8Array> = [];
      let childResolve: (() => void) | null = null;
      let liveChunk: ((chunk: Uint8Array) => void) | null = null;
      const handle = await shareStream.attach(share as any, { send: (data: string | Uint8Array) => sent.push(data) } as any, {
        tmux: {
          capture: async () => "SNAPSHOT-PLAINTEXT\n",
          pipePane: async () => undefined,
        },
        makeFifo: async () => undefined,
        spawnPipeReader: async (_path: string, onChunk: (chunk: Uint8Array) => void) => {
          liveChunk = onChunk;
          return {
            kill: () => undefined,
            exited: new Promise((resolve) => { childResolve = resolve; }),
          };
        },
      } as any);
      liveChunk!(new TextEncoder().encode("LIVE-PLAINTEXT\n"));

      expect(sent).toHaveLength(2);
      expect(sent.every((frame) => frame instanceof Uint8Array)).toBe(true);
      for (const frame of sent as Uint8Array[]) {
        expect(new TextDecoder().decode(frame)).not.toContain("PLAINTEXT");
        expect(shareCrypto.isEncryptedShareFrame(frame)).toBe(true);
      }
      const key = shareCrypto.deriveShareKey(secret);
      expect(new TextDecoder().decode(shareCrypto.decryptShareFrame(key, sent[0] as Uint8Array))).toBe("SNAPSHOT-PLAINTEXT\n");
      expect(new TextDecoder().decode(shareCrypto.decryptShareFrame(key, sent[1] as Uint8Array))).toBe("LIVE-PLAINTEXT\n");

      if (childResolve) childResolve();
      await handle.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("stream fan-out keeps one tmux pipe per target until the last viewer closes", async () => {
    const share: Share = {
      target: "neo:1",
      panes: [],
      readOnly: true,
      tokenHash: "hash",
      expiresAt: Date.now() + 60_000,
      auth: "token",
    };
    const sentA: Array<string | Uint8Array> = [];
    const sentB: Array<string | Uint8Array> = [];
    const pipeCalls: unknown[][] = [];
    const killed: Array<string | number | undefined> = [];
    const createdFifos: string[] = [];
    const removedFifos: string[] = [];
    const chunkHandlers: Array<(chunk: Uint8Array) => void> = [];
    const encoder = new TextEncoder();
    let childResolve: (() => void) | null = null;

    const deps = {
      tmpdir: () => "/tmp",
      join: (...parts: string[]) => parts.join("/"),
      unlinkSync: (path: string) => { removedFifos.push(path); },
      tmux: {
        capture: async () => "SNAPSHOT\n",
        pipePane: async (...args: unknown[]) => { pipeCalls.push(args); },
      },
      makeFifo: async (path: string) => { createdFifos.push(path); },
      spawnPipeReader: async (_path: string, onChunk: (chunk: Uint8Array) => void) => {
        chunkHandlers.push(onChunk);
        return {
          kill: (signal?: string | number) => { killed.push(signal); },
          exited: new Promise((resolve) => { childResolve = () => resolve(0); }),
        };
      },
    } as any;

    const first = await shareStream.attach(share as any, { send: (data: string | Uint8Array) => sentA.push(data) } as any, deps);
    const second = await shareStream.attach(share as any, { send: (data: string | Uint8Array) => sentB.push(data) } as any, deps);

    expect(sentA).toEqual(["SNAPSHOT\n"]);
    expect(sentB).toEqual(["SNAPSHOT\n"]);
    expect(chunkHandlers).toHaveLength(1);
    expect(pipeCalls).toHaveLength(1);
    expect(createdFifos).toHaveLength(1);
    expect(createdFifos[0]).toStartWith("/tmp/maw-share-");
    expect(createdFifos[0]).toEndWith("-neo-1.fifo");
    expect(pipeCalls[0]).toEqual(["neo:1", `cat > '${createdFifos[0]}'`, { onlyIfClosed: true }]);

    chunkHandlers[0]!(encoder.encode("LIVE-1\n"));
    expect(sentA.at(-1)).toEqual(encoder.encode("LIVE-1\n"));
    expect(sentB.at(-1)).toEqual(encoder.encode("LIVE-1\n"));

    await first.close();
    expect(pipeCalls).toHaveLength(1);
    expect(killed).toEqual([]);
    expect(removedFifos).toEqual([]);

    chunkHandlers[0]!(encoder.encode("LIVE-2\n"));
    expect(sentA.map((entry) => entry instanceof Uint8Array ? new TextDecoder().decode(entry) : entry)).toEqual(["SNAPSHOT\n", "LIVE-1\n"]);
    expect(sentB.map((entry) => entry instanceof Uint8Array ? new TextDecoder().decode(entry) : entry)).toEqual(["SNAPSHOT\n", "LIVE-1\n", "LIVE-2\n"]);

    if (childResolve) childResolve();
    await second.close();
    expect(pipeCalls).toEqual([
      ["neo:1", `cat > '${createdFifos[0]}'`, { onlyIfClosed: true }],
      ["neo:1"],
    ]);
    expect(killed).toContain("SIGTERM");
    expect(removedFifos).toEqual([createdFifos[0]]);

    const lsof = Bun.spawnSync(["sh", "-lc", `command -v lsof >/dev/null 2>&1 && lsof ${createdFifos[0]} 2>/dev/null || true`]);
    expect(new TextDecoder().decode(lsof.stdout)).toBe("");
  });

  test("active websocket stream closes and tears down tmux pipe when TTL expires", async () => {
    const share: Share = {
      target: "neo:1",
      panes: [],
      readOnly: true,
      tokenHash: "hash",
      expiresAt: Date.now() + 50,
      auth: "token",
    };
    const sent: Array<string | Uint8Array> = [];
    const closed: Array<[number | undefined, string | undefined]> = [];
    const pipeCalls: unknown[][] = [];
    const clearedTimers: unknown[] = [];
    const timers: Array<{ fn: () => void; ms: number; id: object }> = [];

    await shareStream.attach(
      share as any,
      {
        send: (data: string | Uint8Array) => sent.push(data),
        close: (code?: number, reason?: string) => closed.push([code, reason]),
      } as any,
      {
        tmux: {
          capture: async () => "SNAPSHOT\n",
          pipePane: async (...args: unknown[]) => {
            pipeCalls.push(args);
          },
        },
        makeFifo: async () => undefined,
        spawnPipeReader: async () => ({
          kill: () => undefined,
          exited: Promise.resolve(0),
        }),
        setTimeout: ((fn: () => void, ms: number) => {
          const id = {};
          timers.push({ fn, ms, id });
          return id as any;
        }) as any,
        clearTimeout: ((id: unknown) => {
          clearedTimers.push(id);
        }) as any,
      } as any,
    );

    expect(sent).toEqual(["SNAPSHOT\n"]);
    const expiryTimer = timers.find((timer) => timer.ms <= 50);
    expect(expiryTimer).toBeDefined();

    expiryTimer!.fn();
    for (let i = 0; i < 30; i += 1) await Promise.resolve();

    expect(closed).toEqual([[1008, "share expired"]]);
    expect(pipeCalls.some((call) => call[0] === "neo:1" && call.length === 1)).toBe(true);
    expect(clearedTimers).toContain(expiryTimer!.id);
  });

  test("display URL fails loud for bind-only hosts", () => {
    expect(() => sharePlugin.displayOriginForHost("0.0.0.0", 3457)).toThrow("bind-only host");
    expect(() => sharePlugin.displayOriginForHost("::", 3457)).toThrow("bind-only host");
    expect(() => sharePlugin.displayOriginForHost("http://localhost", 3457)).toThrow("without protocol");
    expect(sharePlugin.displayOriginForHost("::1", 3457)).toBe("http://[::1]:3457");
    expect(sharePlugin.displayOriginForHost("local", 3457)).toBe("http://local:3457");
  });

  test("serve hook registers create, viewer, metadata, and websocket routes", async () => {
    const { result, httpRoutes, wsRoutes } = await makeServeHarness();

    expect(result).toEqual({ ok: true });
    expect(httpRoutes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /api/share",
      "GET /share/:slug",
      "GET /api/share/:slug",
    ]);
    expect(wsRoutes.map((route) => route.path)).toEqual(["/ws/share/:slug"]);
    expect(typeof wsRoutes[0]!.handlers.open).toBe("function");
    expect(typeof wsRoutes[0]!.handlers.message).toBe("function");
    expect(typeof wsRoutes[0]!.handlers.close).toBe("function");

    const create = httpRoutes.find((route) => route.method === "POST" && route.path === "/api/share")!;
    const created = await create.handler(new Request("http://localhost:3457/api/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "neo:1:resolved", ttl: 60, auth: "token" }),
    }));
    expect(created.status).toBe(200);
    const payload = await created.json() as { slug: string; token: string; url: string };
    expect(payload.url).toBe(`http://localhost:3457/share/${payload.slug}#t=${payload.token}`);

    const wsData = wsRoutes[0]!.data(new Request(`http://localhost/ws/share/${payload.slug}?t=${encodeURIComponent(payload.token)}`)) as any;
    expect(wsData.shareSlug).toBe(payload.slug);
    expect(wsData.shareToken).toBe(payload.token);
  });

  test("token auth public API mints, verifies, rejects bad tokens, and expires", async () => {
    const { slug, token, url } = await shareImpl.createShare({ target: "neo:1", panes: ["neo:1.0"], ttl: 1, auth: "token" });

    expect(url).toBe(`/share/${slug}#t=${token}`);
    expect(shareImpl.getShare(slug)).toMatchObject({ target: "neo:1", panes: ["neo:1.0"], auth: "token" });
    await expect(shareImpl.verifyShare(slug, token)).resolves.toBe(true);
    await expect(shareImpl.verifyShare(slug, `${token}-bad`)).resolves.toBe(false);

    const expired = await shareImpl.createShare({ target: "expired", ttl: 0, auth: "token" });
    expect(shareImpl.getShare(expired.slug)).toBeUndefined();
    await expect(shareImpl.verifyShare(expired.slug, expired.token)).resolves.toBe(false);
  });
});
