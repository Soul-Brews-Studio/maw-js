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

function decodeWire(data: string | Uint8Array): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data);
}

function parseWire(data: string | Uint8Array): any {
  return JSON.parse(decodeWire(data));
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
    expect(manifest.cli.flags["--control"]).toBe("boolean");
    expect(manifest.cli.flags["--presence"]).toBe("boolean");
    expect(manifest.cli.flags["--chat"]).toBe("boolean");

    const index = readFileSync(join(root, "src/vendor/mpr-plugins/share/index.ts"), "utf8");
    expect(index).toContain("export async function serve");
    expect(index).toContain("export function setShareWsDepsForTests");
    expect(index).toContain("closing: false");
    expect(index).toContain("await handle.close()");
    expect(index).toContain("void state.handle?.close()");
    expect(index).toContain("export default async function handler");
    expect(index).toContain('"--control": Boolean');
    expect(index).toContain('"--presence": Boolean');
    expect(index).toContain('"--chat": Boolean');
    expect(index).toContain("presence: body.presence === true");
    expect(index).toContain("chat: body.chat === true");
    expect(index).toContain("controlToken");

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
    expect(viewer).toContain("resetPane(pane);");
    expect(viewer).toContain("reconnectTimer = setTimeout(connect, delay);");
    expect(viewer).toContain("const syncPaneDimensions = (pane, dimensions) =>");
    expect(viewer).toContain("pane.term.resize(dimensions.cols, dimensions.rows)");
    expect(viewer).toContain('window.addEventListener("resize", syncAllDimensions)');
    expect(viewer).toContain('window.visualViewport?.addEventListener("resize", syncAllDimensions)');
    expect(viewer).toContain("new ResizeObserver(syncAllDimensions)");
    expect(viewer).toContain("const parseWireFrame = (plain) =>");
    expect(viewer).toContain("const tileToggle = document.getElementById(\"tile-toggle\")");
    expect(viewer).toContain("await loadShareMetadata();");
    expect(viewer).toContain("metadata?.control === true");
    expect(viewer).toContain("metadata?.writeToken");
    expect(viewer).toContain("params.get(\"c\")");
    expect(viewer).toContain("x-maw-control-token");
    expect(viewer).toContain("x-maw-control-signature");
    expect(viewer).toContain("x-maw-share-write-token");
    expect(viewer).toContain("JSON.stringify({ slug, ...body })");
    expect(viewer).toContain("signControlRequest(\"POST\", path, rawBody)");
    expect(viewer).toContain("/api/control/${encodeURIComponent(target)}/${action}");
    expect(viewer).toContain('postControl(controlTargetForPane(pane.id), "send", { text, enter })');
    expect(viewer).toContain('postControl(controlTargetForPane(pane.id), "key", { key })');
    expect(viewer).toContain('postControl(target, "kill")');
    expect(viewer).toContain('root.classList.add("with-controls")');
    expect(viewer).toContain('sendControlKey(pane, "Escape")');
    expect(viewer).not.toContain('postControl(controlTargetForPane(pane.id), "resize"');
  });



  test("share --control mints a separate write token and marks metadata without exposing it through read token", async () => {
    const created = await shareImpl.createShare({ target: "%control", readOnly: false, control: true });
    expect(created.controlToken).toBeTruthy();
    expect(created.controlToken).not.toBe(created.token);
    const share = shareImpl.getShare(created.slug)!;
    expect(share.readOnly).toBe(false);
    expect(share.control?.allowedTargets).toEqual(["%control"]);
    expect(share.control?.tokenHash).not.toBe(share.tokenHash);
    expect(shareImpl.verifyShareControlToken(created.slug, "%control", created.controlToken!)).toEqual({ ok: true, share });
    expect(shareImpl.verifyShareControlToken(created.slug, "%other", created.controlToken!)).toMatchObject({ ok: false, reason: "target_not_allowed", status: 403 });

    const readonly = await shareImpl.createShare({ target: "%read", readOnly: true });
    expect(shareImpl.verifyShareControlToken(readonly.slug, "%read", created.controlToken!)).toMatchObject({ ok: false, reason: "share_read_only", status: 403 });
  });


  test("websocket close before attach resolves tears down the late stream handle", async () => {
    let resolveAttach: ((handle: any) => void) | null = null;
    let handleCloseCalls = 0;
    const restore = sharePlugin.setShareWsDepsForTests({
      attach: async () => new Promise((resolve) => {
        resolveAttach = resolve;
      }),
    });

    try {
      const { httpRoutes, wsRoutes } = await makeServeHarness();
      const createRoute = httpRoutes.find((entry) => entry.method === "POST" && entry.path === "/api/share")!;
      const createRes = await createRoute.handler(new Request("http://local/api/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: "%race", ttl: 60 }),
      }));
      expect(createRes.status).toBe(200);
      const created = await createRes.json() as { slug: string; token: string };
      const route = wsRoutes.find((entry) => entry.path === "/ws/share/:slug")!;
      const sent: string[] = [];
      const closes: Array<[number, string | undefined]> = [];
      const ws = {
        data: { params: { slug: created.slug }, shareSlug: created.slug, shareToken: created.token },
        send: (data: string) => sent.push(data),
        close: (code: number, reason?: string) => closes.push([code, reason]),
      };

      (route.handlers.open as (ws: any) => void)(ws);
      for (let i = 0; i < 10 && !resolveAttach; i += 1) await Promise.resolve();
      expect(resolveAttach).toBeFunction();

      (route.handlers.close as (ws: any) => void)(ws);
      resolveAttach!({
        onMessage: () => undefined,
        close: async () => {
          handleCloseCalls += 1;
        },
      });
      for (let i = 0; i < 5; i += 1) await Promise.resolve();

      expect(handleCloseCalls).toBe(1);
      expect(closes).toEqual([]);
      (route.handlers.message as (ws: any, message: unknown) => void)(ws, "ping");
      expect(sent).toEqual([]);
    } finally {
      restore();
    }
  });

  test("stream default deps preserve real Tmux prototype methods", () => {
    const stream = readFileSync(join(root, "src/vendor/mpr-plugins/share/stream.ts"), "utf8");
    expect(stream).toContain("tmux: deps.tmux ?? baseDeps.tmux");

    const resolved = shareStream.__resolveShareStreamDepsForTests();
    expect(typeof resolved.tmux.capture).toBe("function");
    expect(typeof resolved.tmux.pipePane).toBe("function");
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

  test("share status is rejected before resolving a target or minting a link", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json({ slug: "unexpected", token: "unexpected" });
    }) as typeof fetch;

    try {
      await expect(shareHandler({ source: "cli", args: ["status"] } as any)).resolves.toEqual({
        ok: false,
        error: "maw share: unsupported subcommand 'status'; pass a tmux target instead",
      });
      expect(resolvedTargets).toEqual([]);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  test("share --presence posts daemon flag and exposes read-only metadata", async () => {
    const { httpRoutes } = await makeServeHarness();
    const createRoute = httpRoutes.find((route) => route.method === "POST" && route.path === "/api/share")!;
    const metadataRoute = httpRoutes.find((route) => route.method === "GET" && route.path === "/api/share/:slug")!;
    const originalFetch = globalThis.fetch;
    const postedBodies: unknown[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      postedBodies.push(await req.clone().json());
      return createRoute.handler(req);
    }) as typeof fetch;

    try {
      const result = await shareHandler({
        source: "cli",
        args: ["neo:1", "--presence", "--ttl", "42", "--port", "4567"],
      } as any);

      expect(result.ok).toBe(true);
      expect(postedBodies).toEqual([{ target: "neo:1:resolved", readOnly: true, ttl: 42, auth: "token", presence: true }]);
      const { slug, token } = parseShareOutput(result.output);
      const share = shareRuntimeImpl.getShare(slug)!;
      expect(share.presence).toBe(true);
      expect(share.readOnly).toBe(true);
      expect(share.control).toBeUndefined();

      const metadata = await metadataRoute.handler(new Request(`http://127.0.0.1:4567/api/share/${slug}?token=${encodeURIComponent(token)}`));
      expect(metadata.status).toBe(200);
      await expect(metadata.json()).resolves.toMatchObject({ presence: true, readOnly: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("share --chat posts daemon flag and exposes read-only metadata", async () => {
    const { httpRoutes } = await makeServeHarness();
    const createRoute = httpRoutes.find((route) => route.method === "POST" && route.path === "/api/share")!;
    const metadataRoute = httpRoutes.find((route) => route.method === "GET" && route.path === "/api/share/:slug")!;
    const originalFetch = globalThis.fetch;
    const postedBodies: unknown[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      postedBodies.push(await req.clone().json());
      return createRoute.handler(req);
    }) as typeof fetch;

    try {
      const result = await shareHandler({
        source: "cli",
        args: ["neo:1", "--chat", "--ttl", "42", "--port", "4567"],
      } as any);

      expect(result.ok).toBe(true);
      expect(postedBodies).toEqual([{ target: "neo:1:resolved", readOnly: true, ttl: 42, auth: "token", chat: true }]);
      const { slug, token } = parseShareOutput(result.output);
      const share = shareRuntimeImpl.getShare(slug)!;
      expect(share.chat).toBe(true);
      expect(share.readOnly).toBe(true);
      expect(share.control).toBeUndefined();

      const metadata = await metadataRoute.handler(new Request(`http://127.0.0.1:4567/api/share/${slug}?token=${encodeURIComponent(token)}`));
      expect(metadata.status).toBe(200);
      await expect(metadata.json()).resolves.toMatchObject({ chat: true, readOnly: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  test("cli share accepts multiple pane targets under one token", async () => {
    const { httpRoutes } = await makeServeHarness();
    const createRoute = httpRoutes.find((route) => route.method === "POST" && route.path === "/api/share")!;
    const originalFetch = globalThis.fetch;
    const postedBodies: unknown[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      postedBodies.push(await req.clone().json());
      return createRoute.handler(req);
    }) as typeof fetch;

    try {
      const result = await shareHandler({
        source: "cli",
        args: ["neo:1.0", "neo:1.1", "--port", "4567"],
      } as any);

      expect(result.ok).toBe(true);
      expect(resolvedTargets).toEqual(["neo:1.0", "neo:1.1"]);
      expect(postedBodies).toEqual([{
        target: "neo:1.0:resolved",
        panes: ["neo:1.0:resolved", "neo:1.1:resolved"],
        readOnly: true,
        ttl: 3600,
        auth: "token",
      }]);
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
          run: async () => "80 24",
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
      expect(JSON.parse(new TextDecoder().decode(shareCrypto.decryptShareFrame(key, sent[0] as Uint8Array)))).toEqual({
        type: "maw-share-frame",
        pane: "neo:1:resolved",
        data: "SNAPSHOT-PLAINTEXT\n",
        snapshot: true,
        dimensions: { cols: 80, rows: 24 },
      });
      expect(JSON.parse(new TextDecoder().decode(shareCrypto.decryptShareFrame(key, sent[1] as Uint8Array)))).toEqual({ type: "maw-share-frame", pane: "neo:1:resolved", data: "LIVE-PLAINTEXT\n" });

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
        run: async () => "80 24",
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

    expect(sentA.map(parseWire)).toEqual([{ type: "maw-share-frame", pane: "neo:1", data: "SNAPSHOT\n", snapshot: true, dimensions: { cols: 80, rows: 24 } }]);
    expect(sentB.map(parseWire)).toEqual([{ type: "maw-share-frame", pane: "neo:1", data: "SNAPSHOT\n", snapshot: true, dimensions: { cols: 80, rows: 24 } }]);
    expect(chunkHandlers).toHaveLength(1);
    expect(pipeCalls).toHaveLength(1);
    expect(createdFifos).toHaveLength(1);
    expect(createdFifos[0]).toStartWith("/tmp/maw-share-");
    expect(createdFifos[0]).toEndWith("-neo-1.fifo");
    expect(pipeCalls[0]).toEqual(["neo:1", `cat > '${createdFifos[0]}'`, { onlyIfClosed: true }]);

    chunkHandlers[0]!(encoder.encode("LIVE-1\n"));
    expect(parseWire(sentA.at(-1)!)).toEqual({ type: "maw-share-frame", pane: "neo:1", data: "LIVE-1\n" });
    expect(parseWire(sentB.at(-1)!)).toEqual({ type: "maw-share-frame", pane: "neo:1", data: "LIVE-1\n" });

    await first.close();
    expect(pipeCalls).toHaveLength(1);
    expect(killed).toEqual([]);
    expect(removedFifos).toEqual([]);

    chunkHandlers[0]!(encoder.encode("LIVE-2\n"));
    expect(sentA.map(parseWire)).toEqual([
      { type: "maw-share-frame", pane: "neo:1", data: "SNAPSHOT\n", snapshot: true, dimensions: { cols: 80, rows: 24 } },
      { type: "maw-share-frame", pane: "neo:1", data: "LIVE-1\n" },
    ]);
    expect(sentB.map(parseWire)).toEqual([
      { type: "maw-share-frame", pane: "neo:1", data: "SNAPSHOT\n", snapshot: true, dimensions: { cols: 80, rows: 24 } },
      { type: "maw-share-frame", pane: "neo:1", data: "LIVE-1\n" },
      { type: "maw-share-frame", pane: "neo:1", data: "LIVE-2\n" },
    ]);

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
          run: async () => "80 24",
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

    expect(sent.map(parseWire)).toEqual([{ type: "maw-share-frame", pane: "neo:1", data: "SNAPSHOT\n", snapshot: true, dimensions: { cols: 80, rows: 24 } }]);
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
