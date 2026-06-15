import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import { ServeRouteRegistry } from "../../src/core/serve-route-registry";
import { createIdentityApi } from "../../src/vendor/mpr-plugins/serve-identity/impl";

const root = join(import.meta.dir, "../..");

describe("serve-identity plugin standalone boundary", () => {
  test("declares the serve hook and keeps route registration out of federationApi", () => {
    const manifest = JSON.parse(readFileSync(join(root, "src/vendor/mpr-plugins/serve-identity/plugin.json"), "utf8"));
    expect(manifest.hooks.serve).toMatchObject({ script: "./index.ts", handler: "serve", policy: "fail-fast" });
    expect(manifest.api).toBeUndefined();
    expect(readFileSync(join(root, "src/api/federation.ts"), "utf8")).not.toContain('get("/identity"');
  });

  test("boundary drift is explicit for this core serve route plugin", () => {
    expectStandalonePluginBoundary({
      plugin: "serve-identity",
      requireSdk: false,
      allowRelative: [
        /^\.\.\/\.\.\/\.\.\/config$/,
        /^\.\.\/\.\.\/\.\.\/commands\/shared\/federation-sync$/,
        /^\.\.\/\.\.\/\.\.\/lib\/peer-key$/,
        /^\.\.\/\.\.\/\.\.\/core\/fleet\/node-identity$/,
        /^\.\.\/\.\.\/\.\.\/plugin\/types$/,
      ],
    });
  });

  test("serve hook registers /api/identity on the shared serve route registry", async () => {
    const savedPeerKey = process.env.MAW_PEER_KEY;
    process.env.MAW_PEER_KEY = "hook-peer-key";
    try {
      const { serve } = await import("../../src/vendor/mpr-plugins/serve-identity/index.ts?serve-hook-test");
      const registry = new ServeRouteRegistry();
      await serve({ http: registry.forPlugin({ name: "serve-identity" }) });

      expect(registry.snapshot()).toEqual([{ method: "GET", path: "/api/identity", plugin: "serve-identity" }]);
      const after = await registry.handle(new Request("http://localhost/api/identity"));
      expect(after?.status).toBe(200);
      const body = await after!.json() as Record<string, unknown>;
      expect(body.pubkey).toBe("hook-peer-key");
      expect(body.endpoints).toEqual(expect.arrayContaining(["/api/identity", "/api/send"]));
    } finally {
      if (savedPeerKey === undefined) delete process.env.MAW_PEER_KEY;
      else process.env.MAW_PEER_KEY = savedPeerKey;
    }
  });

  test("serves the unchanged identity response shape", async () => {
    const app = new Elysia().use(createIdentityApi({
      loadConfig: (() => ({ node: "m5", nodeUser: "codex", port: 3456, oracle: "mawjs", agents: { neo: "codex@m5" } })) as any,
      hostedAgents: ((agents: any, node: string) => Object.entries(agents)
        .filter(([, value]) => value === node)
        .map(([name]) => ({ node, name }))) as any,
      getPeerKey: () => "pub",
      packageVersion: "v.test",
      uptime: () => 2.9,
      nowIso: () => "2026-06-07T00:00:00.000Z",
    }));

    const res = await app.handle(new Request("http://localhost/identity"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      node: "codex@m5",
      host: "m5",
      user: "codex",
      port: 3456,
      oracle: "mawjs",
      version: "v.test",
      agents: [{ node: "codex@m5", name: "neo" }],
      uptime: 2,
      clockUtc: "2026-06-07T00:00:00.000Z",
      endpoints: ["/api/agents", "/api/identity", "/api/messages", "/api/pane-keys", "/api/probe", "/api/send", "/api/sleep", "/api/wake"],
      pubkey: "pub",
    });
  });
});
