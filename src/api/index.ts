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
import { pluginDownloadApi } from "./plugin-download";
import { uploadApi } from "./upload";
import { pairApi } from "./pair";
import { consentApi } from "./consent";
import { claudeFleetApi } from "./claude-fleet";
import { discoverPackages, invokePlugin } from "../plugin/registry";
import { federationAuth, fromSigningAuth } from "../lib/elysia-auth";

export const api = new Elysia({ prefix: "/api" })
  .use(cors())
  .use(federationAuth)
  // #804 Step 4 — per-peer "from:" + ed25519 signature verification.
  // Layered AFTER HMAC: fleet membership first, then peer continuity (O6).
  .use(fromSigningAuth)
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
  .use(pluginDownloadApi)
  .use(uploadApi)
  .use(pairApi)
  .use(consentApi)
  .use(claudeFleetApi);

// Snapshot direct-handler routes before plugin auto-mount (#705)
const directRoutes = new Set(
  api.routes.map(r => `${r.method}|${r.path}`),
);

// Auto-mount plugin API surfaces from manifests
const bundledPlugins = discoverPackages();
for (const p of bundledPlugins) {
  if (!p.manifest.api) continue;
  const rawPath = p.manifest.api.path;
  const apiPath = rawPath.startsWith("/api") ? rawPath.slice(4) : rawPath;
  const { methods } = p.manifest.api;
  for (const method of methods) {
    if (directRoutes.has(`${method}|${apiPath}`)) {
      process.stderr.write(
        `[maw] ⚠ plugin '${p.manifest.name}' declares ${method} ${rawPath} — ` +
        `collides with direct handler, skipping auto-mount\n`,
      );
      continue;
    }
    if (method === "GET") {
      api.get(apiPath, async ({ query }) => {
        const result = await invokePlugin(p, { source: "api", args: query ?? {} });
        return result;
      });
    } else if (method === "POST") {
      api.post(apiPath, async ({ body }) => {
        const result = await invokePlugin(p, { source: "api", args: body ?? {} });
        return result;
      });
    }
  }
}
