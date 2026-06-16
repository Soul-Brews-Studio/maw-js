import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import { ServeRouteRegistry } from "../../src/core/serve-route-registry";

describe("serve-views plugin", () => {
  test("keeps a declared standalone boundary", () => {
    expectStandalonePluginBoundary({
      plugin: "serve-views",
      requireSdk: false,
      allowRelative: [/^\.\.\/\.\.\/\.\.\/core\/xdg$/, /^\.\.\/\.\.\/\.\.\/core\/serve-route-registry$/],
    });
  });

  test("registers the Hono views fallback through the serve hook", async () => {
    const { createViews, serve } = await import("../../src/vendor/mpr-plugins/serve-views/index.ts?standalone-register");
    const tmp = mkdtempSync(join(tmpdir(), "maw-serve-views-register-"));
    const registry = new ServeRouteRegistry();

    try {
      const views = createViews(join(tmp, "missing-ui"), join(tmp, "missing-door.html"));

      await serve({ http: registry, plugin: { name: "serve-views" } }, { views });
      await serve({ http: registry, plugin: { name: "serve-views" } }, { views });

      expect(registry.listFallbacks()).toEqual(["serve-views"]);
      const response = await registry.handleFallback(new Request("http://local/"));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("maw-ui not installed");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("createViews preserves topology and door fallback behavior", async () => {
    const { createViews } = await import("../../src/vendor/mpr-plugins/serve-views/index.ts?standalone-create");
    const tmp = mkdtempSync(join(tmpdir(), "maw-serve-views-"));
    const previousCwd = process.cwd();
    const previousWrite = process.stderr.write;
    const stderr: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      mkdirSync(join(tmp, "ψ", "outbox"), { recursive: true });
      writeFileSync(join(tmp, "ψ", "outbox", "fleet-topology.html"), "<h1>topology</h1>");
      process.chdir(tmp);

      const views = createViews(join(tmp, "missing-ui"), join(tmp, "missing-door.html"));

      expect(await (await views.request("http://local/topology")).text()).toContain("topology");
      rmSync(join(tmp, "ψ"), { recursive: true, force: true });
      expect((await views.request("http://local/topology")).status).toBe(404);
      expect(await (await views.request("http://local/")).text()).toContain("maw-ui not installed");
      expect(stderr.join("")).not.toContain("maw-ui not found");
    } finally {
      process.chdir(previousCwd);
      process.stderr.write = previousWrite;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("createViews does not print missing-ui warnings when called repeatedly", async () => {
    const { createViews } = await import("../../src/vendor/mpr-plugins/serve-views/index.ts?standalone-create-repeat");
    const tmp = mkdtempSync(join(tmpdir(), "maw-serve-views-repeat-"));
    const previousWrite = process.stderr.write;
    const stderr: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      createViews(join(tmp, "missing-ui"), join(tmp, "missing-door.html"));
      createViews(join(tmp, "missing-ui"), join(tmp, "missing-door.html"));

      expect(stderr.join("")).not.toContain("maw-ui not found");
    } finally {
      process.stderr.write = previousWrite;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
