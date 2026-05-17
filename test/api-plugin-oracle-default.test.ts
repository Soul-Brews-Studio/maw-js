import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  createPluginListManifestApi,
  toPeerPluginEntry,
} from "../src/api/plugin-list-manifest";
import { createOracleApi } from "../src/api/oracle";
import type { LoadedPlugin } from "../src/plugin/types";

async function json(res: Response): Promise<any> {
  return await res.json();
}

function apiWith(plugin: Elysia) {
  return new Elysia({ prefix: "/api" }).use(plugin);
}

function plugin(manifest: Partial<LoadedPlugin["manifest"]>): LoadedPlugin {
  return {
    dir: `/plugins/${manifest.name ?? "demo"}`,
    wasmPath: "",
    kind: "ts",
    manifest: {
      name: "demo",
      version: "1.0.0",
      sdk: "^1.0.0",
      entry: "index.ts",
      ...manifest,
    },
  };
}

describe("plugin manifest API default-suite coverage", () => {
  test("toPeerPluginEntry preserves advisory metadata and explicit tiers", () => {
    expect(toPeerPluginEntry(plugin({
      name: "fleet-ui",
      version: "2.0.0",
      tier: "standard",
      description: "Fleet dashboard",
      author: "Soul Brews",
      artifact: { path: "dist/index.js", sha256: "abc123" },
    }))).toEqual({
      name: "fleet-ui",
      version: "2.0.0",
      tier: "standard",
      summary: "Fleet dashboard",
      author: "Soul Brews",
      sha256: "abc123",
      downloadUrl: "/api/plugin/download/fleet-ui",
    });
  });

  test("toPeerPluginEntry infers tiers from weight and encodes download names", () => {
    expect(toPeerPluginEntry(plugin({ name: "core-tool", weight: 1 })).tier).toBe("core");
    expect(toPeerPluginEntry(plugin({ name: "standard-tool", weight: 20 })).tier).toBe("standard");
    expect(toPeerPluginEntry(plugin({ name: "extra/tool", weight: 99 })).downloadUrl)
      .toBe("/api/plugin/download/extra%2Ftool");
    expect(toPeerPluginEntry(plugin({ name: "unbuilt", artifact: { path: "dist/index.js", sha256: null } })))
      .toMatchObject({ sha256: null });
  });

  test("GET /api/plugin/list-manifest renders discovered plugin entries", async () => {
    const app = apiWith(createPluginListManifestApi({
      discoverPackages: () => [
        plugin({ name: "messages", version: "1.2.3", weight: 20 }),
        plugin({ name: "fleet-ui", version: "2.0.0", tier: "extra", author: "Nat" }),
      ],
      loadConfig: () => ({ node: "m5" }) as any,
    }));

    const res = await app.handle(new Request("http://local/api/plugin/list-manifest"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      schemaVersion: 1,
      node: "m5",
      pluginCount: 2,
      plugins: [
        {
          name: "messages",
          version: "1.2.3",
          tier: "standard",
          downloadUrl: "/api/plugin/download/messages",
        },
        {
          name: "fleet-ui",
          version: "2.0.0",
          tier: "extra",
          author: "Nat",
          downloadUrl: "/api/plugin/download/fleet-ui",
        },
      ],
    });
  });

  test("GET /api/plugin/list-manifest falls back to unknown node", async () => {
    const app = apiWith(createPluginListManifestApi({
      discoverPackages: () => [],
      loadConfig: () => ({}) as any,
    }));

    const res = await app.handle(new Request("http://local/api/plugin/list-manifest"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      schemaVersion: 1,
      node: "unknown",
      pluginCount: 0,
      plugins: [],
    });
  });
});

describe("oracle API default-suite coverage", () => {
  test("search requires q before proxying to Oracle", async () => {
    const app = apiWith(createOracleApi({
      getOracleUrl: () => "http://oracle.local",
      fetch: (async () => new Response("{}")) as any,
    }));

    const res = await app.handle(new Request("http://local/api/oracle/search"));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "q required" });
  });

  test("search forwards defaults plus explicit model to Oracle", async () => {
    const urls: string[] = [];
    const app = apiWith(createOracleApi({
      getOracleUrl: () => "http://oracle.local",
      fetch: (async (url) => {
        urls.push(String(url));
        return Response.json({ hits: [{ title: "maw" }] });
      }) as any,
    }));

    const res = await app.handle(new Request("http://local/api/oracle/search?q=maw&model=gpt&limit=3"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ hits: [{ title: "maw" }] });
    expect(urls).toEqual(["http://oracle.local/api/search?q=maw&mode=hybrid&limit=3&model=gpt"]);
  });

  test("traces and stats forward to Oracle", async () => {
    const urls: string[] = [];
    const app = apiWith(createOracleApi({
      getOracleUrl: () => "http://oracle.local",
      fetch: (async (url) => {
        urls.push(String(url));
        if (String(url).includes("/traces")) return Response.json({ traces: [1] });
        return Response.json({ ok: true });
      }) as any,
    }));

    const traces = await app.handle(new Request("http://local/api/oracle/traces"));
    expect(traces.status).toBe(200);
    expect(await json(traces)).toEqual({ traces: [1] });

    const stats = await app.handle(new Request("http://local/api/oracle/stats"));
    expect(stats.status).toBe(200);
    expect(await json(stats)).toEqual({ ok: true });

    expect(urls).toEqual([
      "http://oracle.local/api/traces?limit=10",
      "http://oracle.local/api/stats",
    ]);
  });

  test("default Oracle URL resolver honors ORACLE_URL when only fetch is injected", async () => {
    const previous = process.env.ORACLE_URL;
    process.env.ORACLE_URL = "http://env-oracle.local";
    const urls: string[] = [];
    try {
      const app = apiWith(createOracleApi({
        fetch: (async (url) => {
          urls.push(String(url));
          return Response.json({ env: true });
        }) as any,
      }));

      const res = await app.handle(new Request("http://local/api/oracle/stats"));
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ env: true });
      expect(urls).toEqual(["http://env-oracle.local/api/stats"]);
    } finally {
      if (previous === undefined) delete process.env.ORACLE_URL;
      else process.env.ORACLE_URL = previous;
    }
  });

  test("default fetch branch remains available when only URL resolution is injected", async () => {
    const oldFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url) => {
      urls.push(String(url));
      return Response.json({ global: true });
    }) as any;
    try {
      const app = apiWith(createOracleApi({
        getOracleUrl: () => "http://global-fetch-oracle.local",
      }));
      const res = await app.handle(new Request("http://local/api/oracle/stats"));
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ global: true });
      expect(urls).toEqual(["http://global-fetch-oracle.local/api/stats"]);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  test("Oracle fetch failures return 502 for all proxy routes", async () => {
    const app = apiWith(createOracleApi({
      getOracleUrl: () => "http://oracle.local",
      fetch: (async () => {
        throw new Error("offline");
      }) as any,
    }));

    for (const path of [
      "/api/oracle/search?q=maw&mode=vector",
      "/api/oracle/traces?limit=2",
      "/api/oracle/stats",
    ]) {
      const res = await app.handle(new Request(`http://local${path}`));
      expect(res.status).toBe(502);
      expect(await json(res)).toEqual({ error: "Oracle unreachable: offline" });
    }
  });
});
