/**
 * Tests for src/api/plugins.ts — GET/POST /api/plugins surface.
 *
 * Uses the router factory dependency seam so the default suite stays isolated
 * from the developer machine plugin registry and avoids module-cache mocks.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { createPluginsRouter } from "../src/api/plugins";
import type { InvokeResult, LoadedPlugin } from "../src/plugin/types";

const FAKE_PLUGINS: LoadedPlugin[] = [
  {
    manifest: { name: "hello", version: "1.0.0", wasm: "hello.wasm", sdk: "maw", api: { path: "/hello", methods: ["POST"] } },
    dir: "/tmp/hello", wasmPath: "/tmp/hello/hello.wasm",
  },
  {
    manifest: { name: "info", version: "0.2.0", wasm: "info.wasm", sdk: "maw", api: { path: "/info", methods: ["GET"] } },
    dir: "/tmp/info", wasmPath: "/tmp/info/info.wasm",
  },
  {
    manifest: { name: "both", version: "0.3.0", wasm: "both.wasm", sdk: "maw", api: { path: "/both", methods: ["GET", "POST"] } },
    dir: "/tmp/both", wasmPath: "/tmp/both/both.wasm",
  },
  {
    manifest: { name: "no-api", version: "0.1.0", wasm: "noop.wasm", sdk: "maw" },
    dir: "/tmp/no-api", wasmPath: "/tmp/no-api/noop.wasm",
  },
];

let fakeInvokeResult: InvokeResult = { ok: true, output: "ok" };
let calls: any[] = [];
let app: Elysia;

beforeEach(() => {
  fakeInvokeResult = { ok: true, output: "ok" };
  calls = [];
  app = new Elysia({ prefix: "/api" }).use(createPluginsRouter({
    discoverPackages: () => FAKE_PLUGINS,
    invokePlugin: async (plugin, ctx) => {
      calls.push({ plugin: plugin.manifest.name, ctx });
      return fakeInvokeResult;
    },
  }));
});

describe("GET /api/plugins", () => {
  test("returns only plugins that expose an api surface", async () => {
    const res = await app.handle(new Request("http://localhost/api/plugins"));
    expect(res.status).toBe(200);
    const body: { name: string }[] = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.map(p => p.name)).toEqual(["hello", "info", "both"]);
  });
});

describe("POST /api/plugins/:name", () => {
  test("404 for unknown plugin name", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/plugins/does-not-exist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toInclude("does-not-exist");
  });

  test("405 when POST not listed in manifest.api.methods", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/plugins/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: "test" }),
      })
    );
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  test("200 + output on successful invocation", async () => {
    fakeInvokeResult = { ok: true, output: "hello world" };
    const res = await app.handle(
      new Request("http://localhost/api/plugins/hello", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.output).toBe("hello world");
    expect(calls).toEqual([
      { plugin: "hello", ctx: { source: "api", args: { message: "hi" } } },
    ]);
  });

  test("defaults missing body to empty args", async () => {
    fakeInvokeResult = { ok: true, output: "empty" };
    const res = await app.handle(
      new Request("http://localhost/api/plugins/hello", { method: "POST" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, output: "empty" });
    expect(calls).toEqual([
      { plugin: "hello", ctx: { source: "api", args: {} } },
    ]);
  });

  test("500 when invokePlugin returns ok:false", async () => {
    fakeInvokeResult = { ok: false, error: "wasm panic" };
    const res = await app.handle(
      new Request("http://localhost/api/plugins/hello", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("wasm panic");
  });
});

describe("GET /api/plugins/:name", () => {
  test("404 for unknown plugin name", async () => {
    const res = await app.handle(new Request("http://localhost/api/plugins/missing"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "plugin 'missing' not found" });
  });

  test("200 for GET-enabled plugin with query args", async () => {
    fakeInvokeResult = { ok: true, output: "info output" };
    const res = await app.handle(
      new Request("http://localhost/api/plugins/info?key=val")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.output).toBe("info output");
    expect(calls).toEqual([
      { plugin: "info", ctx: { source: "api", args: { key: "val" } } },
    ]);
  });

  test("405 when GET not listed in manifest.api.methods", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/plugins/hello")
    );
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  test("500 with default error when invokePlugin returns ok:false", async () => {
    fakeInvokeResult = { ok: false };
    const res = await app.handle(
      new Request("http://localhost/api/plugins/info")
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: "invoke failed" });
  });
});
