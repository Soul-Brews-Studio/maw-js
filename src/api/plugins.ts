/**
 * Plugins API — HTTP surface for package-based plugins (plugin.json manifest).
 *
 * Routes (mounted under /api):
 *   GET  /plugins          → list plugins that expose an API surface
 *   GET  /plugins/:name    → invoke plugin via GET (query params as args)
 *   POST /plugins/:name    → invoke plugin via POST (body as args)
 *
 * Depends on manifest-foundation's src/plugin/registry.ts + src/plugin/types.ts.
 * Auth: POST routes are guarded by the HMAC middleware in lib/elysia-auth.ts
 * (see isProtected — /plugins/ prefix is protected for POST).
 */

import { Elysia, t } from "elysia";
import type { LoadedPlugin, InvokeContext, InvokeResult } from "../plugin/types";
import { discoverPackages, invokePlugin } from "../plugin/registry";

export const pluginsRouter = new Elysia();

// GET /plugins — list all plugins that expose an API surface
pluginsRouter.get("/plugins", () => {
  const all = discoverPackages();
  return all
    .filter((p: LoadedPlugin) => !!p.manifest.api)
    .map((p: LoadedPlugin) => ({
      name: p.manifest.name,
      version: p.manifest.version,
      api: p.manifest.api,
    }));
});

// GET /plugins/:name — invoke plugin via GET (args from query params)
pluginsRouter.get("/plugins/:name", async ({ params, query, set }) => {
  const all = discoverPackages();
  const plugin: LoadedPlugin | undefined = all.find(
    (p: LoadedPlugin) => p.manifest.name === params.name
  );

  if (!plugin) {
    set.status = 404;
    return { ok: false, error: `plugin '${params.name}' not found` };
  }
  if (!plugin.manifest.api?.methods.includes("GET")) {
    set.status = 405;
    return { ok: false, error: "method not allowed" };
  }

  const result: InvokeResult = await invokePlugin(plugin, {
    source: "api",
    args: query as Record<string, unknown>,
  } satisfies InvokeContext);

  if (!result.ok) {
    set.status = 500;
    return { ok: false, error: result.error ?? "invoke failed" };
  }
  return { ok: true, output: result.output };
});

// POST /plugins/:name — invoke plugin via POST (args from request body)
pluginsRouter.post(
  "/plugins/:name",
  async ({ params, body, set }) => {
    const all = discoverPackages();
    const plugin: LoadedPlugin | undefined = all.find(
      (p: LoadedPlugin) => p.manifest.name === params.name
    );

    if (!plugin) {
      set.status = 404;
      return { ok: false, error: `plugin '${params.name}' not found` };
    }
    if (!plugin.manifest.api?.methods.includes("POST")) {
      set.status = 405;
      return { ok: false, error: "method not allowed" };
    }

    const result: InvokeResult = await invokePlugin(plugin, {
      source: "api",
      args: (body ?? {}) as Record<string, unknown>,
    } satisfies InvokeContext);

    if (!result.ok) {
      set.status = 500;
      return { ok: false, error: result.error ?? "invoke failed" };
    }
    return { ok: true, output: result.output };
  },
  { body: t.Optional(t.Unknown()) }
);
