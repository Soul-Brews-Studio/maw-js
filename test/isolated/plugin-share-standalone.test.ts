import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const realConfig = await import("../../src/config.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const resolvedTargets: string[] = [];

const configMock = {
  ...realConfig,
  loadConfig: () => ({ host: "127.0.0.1", port: 3456 }),
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

describe("share plugin standalone boundary (#2685)", () => {
  test("manifest-backed sources expose the CLI command and serve hook", () => {
    const manifest = JSON.parse(readFileSync(join(root, "src/vendor/mpr-plugins/share/plugin.json"), "utf8"));
    expect(manifest.name).toBe("share");
    expect(manifest.cli.command).toBe("share");
    expect(manifest.hooks.serve.handler).toBe("serve");

    const index = readFileSync(join(root, "src/vendor/mpr-plugins/share/index.ts"), "utf8");
    expect(index).toContain("export async function serve");
    expect(index).toContain("export default async function handler");
  });

  test("cli share dispatch parses read-only, ttl, port, and auth flags", async () => {
    const result = await shareHandler({
      source: "cli",
      args: ["neo:1", "--read-only", "--ttl", "42", "--port", "4567", "--auth", "token"],
    } as any);

    expect(result.ok).toBe(true);
    expect(resolvedTargets).toEqual(["neo:1"]);
    expect(result.output).toMatch(/^http:\/\/127\.0\.0\.1:4567\/share\/[a-z0-9]+#t=.+/);

    const match = String(result.output).match(/\/share\/([^#]+)#t=(.+)$/);
    expect(match).toBeTruthy();
    const slug = match![1]!;
    const token = match![2]!;
    expect(slug).toMatch(/^[a-z0-9]+$/);
    expect(token.length).toBeGreaterThan(10);
  });

  test("serve hook registers viewer, metadata, and websocket routes", async () => {
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

    expect(result).toEqual({ ok: true });
    expect(httpRoutes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /share/:slug",
      "GET /api/share/:slug",
    ]);
    expect(wsRoutes.map((route) => route.path)).toEqual(["/ws/share/:slug"]);
    expect(typeof wsRoutes[0]!.handlers.open).toBe("function");
    expect(typeof wsRoutes[0]!.handlers.message).toBe("function");
    expect(typeof wsRoutes[0]!.handlers.close).toBe("function");

    const created = await shareHandler({ source: "cli", args: ["neo:1", "--ttl", "60"] } as any);
    const match = String(created.output).match(/\/share\/([^#]+)#t=(.+)$/);
    expect(match).toBeTruthy();
    const slug = match![1]!;
    const token = match![2]!;
    const metadata = httpRoutes.find((route) => route.path === "/api/share/:slug")!;
    const response = await metadata.handler(new Request(`http://localhost/api/share/${slug}?token=${encodeURIComponent(token)}`));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      target: "neo:1:resolved",
      readOnly: true,
      auth: "token",
    });

    const wsData = wsRoutes[0]!.data(new Request(`http://localhost/ws/share/${slug}?t=${encodeURIComponent(token)}`)) as any;
    expect(wsData.shareSlug).toBe(slug);
    expect(wsData.shareToken).toBe(token);
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
