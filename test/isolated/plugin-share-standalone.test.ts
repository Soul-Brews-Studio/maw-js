import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const realConfig = await import("../../src/config.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const resolvedTargets: string[] = [];

const configMock = {
  ...realConfig,
  loadConfig: () => ({ host: "127.0.0.1" }),
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
const shareHandler = sharePlugin.default;

beforeEach(() => {
  resolvedTargets.length = 0;
  shareImpl.clearShareRegistry();
});

function parseShareOutput(output: unknown): { slug: string; token: string } {
  const match = String(output).match(/\/share\/([^#]+)#t=(.+)$/);
  expect(match).toBeTruthy();
  return { slug: match![1]!, token: match![2]! };
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
  test("manifest-backed sources expose the CLI command and serve hook", () => {
    const manifest = JSON.parse(readFileSync(join(root, "src/vendor/mpr-plugins/share/plugin.json"), "utf8"));
    expect(manifest.name).toBe("share");
    expect(manifest.cli.command).toBe("share");
    expect(manifest.hooks.serve.handler).toBe("serve");

    const index = readFileSync(join(root, "src/vendor/mpr-plugins/share/index.ts"), "utf8");
    expect(index).toContain("export async function serve");
    expect(index).toContain("export default async function handler");
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
      expect(result.output).toMatch(/^http:\/\/127\.0\.0\.1:4567\/share\/[a-z0-9]+#t=.+/);

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

    expect(url).toBe(`/share/${slug}#${token}`);
    expect(shareImpl.getShare(slug)).toMatchObject({ target: "neo:1", panes: ["neo:1.0"], auth: "token" });
    await expect(shareImpl.verifyShare(slug, token)).resolves.toBe(true);
    await expect(shareImpl.verifyShare(slug, `${token}-bad`)).resolves.toBe(false);

    const expired = await shareImpl.createShare({ target: "expired", ttl: 0, auth: "token" });
    expect(shareImpl.getShare(expired.slug)).toBeUndefined();
    await expect(shareImpl.verifyShare(expired.slug, expired.token)).resolves.toBe(false);
  });
});
