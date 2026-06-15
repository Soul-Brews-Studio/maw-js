import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { renderPluginsPage, serve } from "../../src/vendor/mpr-plugins/serve-debug/index";

const root = join(import.meta.dir, "../..");
const pluginDir = join(root, "src/vendor/mpr-plugins/serve-debug");

function makeContext() {
  const calls: Array<{ method: string; path: string; handler: (request: Request) => Response | Promise<Response> }> = [];
  const http = {
    route: (method: any, path: string, handler: (request: Request) => Response | Promise<Response>) => calls.push({ method, path, handler }),
  };
  const stats = {
    startedAt: new Date(Date.now() - 65_000).toISOString(),
    plugins: [{ name: "shell-hooks", type: "ts", events: 3, errors: 0, loadedAt: new Date().toISOString(), lastEvent: "MessageSend" }],
    totalEvents: 3,
    totalErrors: 0,
    gated: 0,
    gates: { "*": 1 },
    filters: {},
    handlers: { MessageSend: 1 },
    lates: {},
  };
  return {
    calls,
    ctx: {
      http,
      plugins: { stats: () => stats },
      reloadPlugins: async () => ({ ok: true, reloaded: true, ...stats }),
    },
  };
}

describe("serve-debug plugin standalone boundary (#2436)", () => {
  test("is a manifest-backed serve lifecycle plugin with no core imports", () => {
    const manifest = loadManifestFromDir(pluginDir)?.manifest;
    expect(manifest?.name).toBe("serve-debug");
    expect(manifest?.hooks?.serve).toMatchObject({ script: "./index.ts", handler: "serve" });

    const imports = expectStandalonePluginBoundary({ plugin: "serve-debug", requireSdk: false });
    expect(imports.map((record) => record.spec).filter((spec) => spec.startsWith("../"))).toEqual([]);
    const source = readFileSync(join(pluginDir, "index.ts"), "utf8");
    expect(source).toContain("ServeHttpRouteRegistrar");
  });

  test("registers plugin debug API and page routes through the serve hook", async () => {
    const { calls, ctx } = makeContext();
    expect(serve(ctx)).toEqual({ ok: true });

    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/plugins",
      "POST /api/plugins/reload",
      "GET /plugins",
    ]);

    const statsResponse = await calls[0].handler(new Request("http://local/api/plugins"));
    const reloadResponse = await calls[1].handler(new Request("http://local/api/plugins/reload", { method: "POST" }));
    const htmlResponse = await calls[2].handler(new Request("http://local/plugins"));

    expect(await statsResponse.json()).toMatchObject({ totalEvents: 3, plugins: [{ name: "shell-hooks" }] });
    expect(await reloadResponse.json()).toMatchObject({ ok: true, reloaded: true });
    const html = await htmlResponse.text();
    expect(htmlResponse.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("Plugin System v2");
    expect(html).toContain("shell-hooks");
  });

  test("HTML rendering escapes plugin stats", () => {
    const html = renderPluginsPage({
      startedAt: new Date().toISOString(),
      plugins: [{ name: "<script>alert(1)</script>", type: "ts", events: 1, errors: 0, loadedAt: new Date().toISOString(), lastEvent: "A&B" }],
      totalEvents: 1,
      totalErrors: 0,
      handlers: { "A<B": 1 },
    });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("A&amp;B");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("source owns the former core plugin debug paths", () => {
    const source = readFileSync(join(pluginDir, "index.ts"), "utf8");
    expect(source).toContain('"/api/plugins"');
    expect(source).toContain('"/api/plugins/reload"');
    expect(source).toContain('"/plugins"');
  });
});
