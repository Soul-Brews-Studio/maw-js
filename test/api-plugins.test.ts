/**
 * Tests for src/api/plugins.ts — GET/POST /api/plugins surface.
 *
 * Registry is stubbed via mock.module (manifest-foundation may not be landed).
 * Uses Elysia's .handle() for in-process dispatch — no port binding.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { mock } from "bun:test";
import { Elysia } from "elysia";

// --- Stub types (mirrors src/plugin/types.ts contract) ---

interface PluginManifest {
  name: string;
  version: string;
  wasm: string;
  sdk: string;
  api?: { path: string; methods: ("GET" | "POST")[] };
}
interface LoadedPlugin { manifest: PluginManifest; dir: string; wasmPath: string; }

// --- Stub registry data ---

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
    manifest: { name: "no-api", version: "0.1.0", wasm: "noop.wasm", sdk: "maw" },
    dir: "/tmp/no-api", wasmPath: "/tmp/no-api/noop.wasm",
  },
];

// Mutable invoke result — set per-test to control invokePlugin behaviour
let fakeInvokeResult: { ok: boolean; output?: string; error?: string } =
  { ok: true, output: "ok" };

// Register module stubs BEFORE dynamic import of the router
mock.module("../src/plugin/registry", () => ({
  discoverPackages: () => FAKE_PLUGINS,
  invokePlugin: async (_p: LoadedPlugin, _ctx: unknown) => fakeInvokeResult,
}));

// Stub types module (import type is erased at runtime, but guard for safety)
mock.module("../src/plugin/types", () => ({}));

// --- Build test app ---

let app: Elysia;

beforeAll(async () => {
  const { pluginsRouter } = await import("../src/api/plugins");
  app = new Elysia({ prefix: "/api" }).use(pluginsRouter);
});

// --- Tests ---

describe("GET /api/plugins", () => {
  test("returns only plugins that expose an api surface", async () => {
    const res = await app.handle(new Request("http://localhost/api/plugins"));
    expect(res.status).toBe(200);
    const body: { name: string }[] = await res.json();
    expect(Array.isArray(body)).toBe(true);
    // 'no-api' plugin has no manifest.api — must be excluded
    expect(body.map(p => p.name)).toEqual(["hello", "info"]);
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
    // 'info' plugin only exposes GET
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
  test("200 for GET-enabled plugin with query args", async () => {
    fakeInvokeResult = { ok: true, output: "info output" };
    const res = await app.handle(
      new Request("http://localhost/api/plugins/info?key=val")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.output).toBe("info output");
  });

  test("405 when GET not listed in manifest.api.methods", async () => {
    // 'hello' plugin only exposes POST
    const res = await app.handle(
      new Request("http://localhost/api/plugins/hello")
    );
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
