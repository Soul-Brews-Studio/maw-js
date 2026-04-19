import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { sessionsApi } from "./sessions";
import { feedApi } from "./feed";
import { teamsApi } from "./teams";
import { configApi } from "./config";
import { fleetApi } from "./fleet";
import { asksApi } from "./asks";
import { oracleApi } from "./oracle";
import { federationApi } from "./federation";
import { worktreesApi } from "./worktrees";
import { uiStateApi } from "./ui-state";
import { deprecatedApi } from "./deprecated";
import { costsApi } from "./costs";
import { triggersApi } from "./triggers";
import { avengersApi } from "./avengers";
import { transportApi } from "./transport";
import { workspaceApi } from "./workspace";
import { peerExecApi } from "./peer-exec";
import { proxyApi } from "./proxy";
import { pulseApi } from "./pulse";
import { pluginsRouter } from "./plugins";
import { pluginListManifestApi } from "./plugin-list-manifest";
import { uploadApi } from "./upload";
import { pairApi } from "./pair";
import { discoverPackages, invokePlugin } from "../plugin/registry";
import { federationAuth } from "../lib/elysia-auth";

export const api = new Elysia({ prefix: "/api" })
  .use(cors())
  .use(federationAuth)
  .onAfterHandle(({ set }) => {
    set.headers["Access-Control-Allow-Private-Network"] = "true";
  })
  .use(swagger({
    path: "/docs",
    documentation: {
      info: { title: "maw-js API", version: "2.0.0-alpha.1" },
      description: "Multi-Agent Workflow API — federation, sessions, plugins, workspace",
    },
  }))
  .use(sessionsApi)
  .use(feedApi)
  .use(teamsApi)
  .use(configApi)
  .use(fleetApi)
  .use(asksApi)
  .use(oracleApi)
  .use(federationApi)
  .use(worktreesApi)
  .use(uiStateApi)
  .use(deprecatedApi)
  .use(costsApi)
  .use(triggersApi)
  .use(avengersApi)
  .use(transportApi)
  .use(workspaceApi)
  .use(peerExecApi)
  .use(proxyApi)
  .use(pulseApi)
  .use(pluginsRouter)
  .use(pluginListManifestApi)
  .use(uploadApi)
  .use(pairApi);

// Auto-mount plugin API surfaces from manifests
const bundledPlugins = discoverPackages();
for (const p of bundledPlugins) {
  if (!p.manifest.api) continue;
  // Strip /api prefix from manifest path — Elysia already has prefix: "/api"
  const rawPath = p.manifest.api.path;
  const apiPath = rawPath.startsWith("/api") ? rawPath.slice(4) : rawPath;
  const { methods } = p.manifest.api;
  if (methods.includes("GET")) {
    api.get(apiPath, async ({ query }) => {
      const result = await invokePlugin(p, { source: "api", args: query ?? {} });
      return result;
    });
  }
  if (methods.includes("POST")) {
    api.post(apiPath, async ({ body }) => {
      const result = await invokePlugin(p, { source: "api", args: body ?? {} });
      return result;
    });
  }
}
