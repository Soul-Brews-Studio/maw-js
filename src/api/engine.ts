/**
 * Dynamic engine plugin API (#1566).
 *
 * Static plugin APIs are mounted in-process from manifest.api. Dynamic engine
 * plugins own a persistent local process and register a gateway prefix that
 * maw serve reverse-proxies to their loopback HTTP server.
 */

import { Elysia, t } from "elysia";
import {
  listEnginePluginRegistrations,
  registerEnginePlugin,
  unregisterEnginePlugin,
} from "../core/engine-plugin-registry";

export const engineApi = new Elysia();

engineApi.get("/_engine/registrations", () => ({
  ok: true,
  registrations: listEnginePluginRegistrations(),
}));

engineApi.post(
  "/_engine/register",
  ({ body, set }) => {
    try {
      const registration = registerEnginePlugin(body);
      set.status = 201;
      return { ok: true, bound: true, registration };
    } catch (err) {
      set.status = 400;
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  {
    body: t.Object({
      plugin: t.String(),
      prefix: t.String(),
      upstream: t.String(),
      events: t.Optional(t.Array(t.String())),
      health: t.Optional(t.String()),
    }),
  },
);

engineApi.post(
  "/_engine/unregister",
  ({ body, set }) => {
    try {
      const removed = unregisterEnginePlugin(body);
      return { ok: true, removed };
    } catch (err) {
      set.status = 400;
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  {
    body: t.Object({
      plugin: t.Optional(t.String()),
      prefix: t.Optional(t.String()),
    }),
  },
);
