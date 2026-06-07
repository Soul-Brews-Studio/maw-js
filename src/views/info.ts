import { Hono } from "hono";
import { hostname } from "os";
import { readFileSync } from "fs";
import { join } from "path";
import { loadConfig } from "../config";
import { resolveNickname } from "../core/fleet/nicknames";
import { resolveNodeIdentity } from "../core/fleet/node-identity";

/**
 * Self-describing maw field — schema "1" (#628).
 *
 * Lets peers discover capabilities in a single /info round-trip instead
 * of probing multiple endpoints. Back-compat: old clients that check
 * `body.maw === true` break; new clients should gate on any truthy
 * `body.maw` (see src/commands/plugins/peers/probe.ts).
 */
export interface InfoMaw {
  schema: "1";
  plugins: {
    manifestEndpoint: string;
  };
  capabilities: string[];
}

export interface InfoResponse {
  node: string;
  host?: string;
  user?: string;
  port?: number;
  version: string;
  ts: string;
  /** Optional human-friendly nickname for this oracle (#643 Phase 2). */
  nickname?: string;
  maw: InfoMaw;
}

function readVersion(): string {
  try {
    const pkgPath = join(import.meta.dir, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}

function readIdentity(): ReturnType<typeof resolveNodeIdentity> {
  try {
    const cfg = loadConfig();
    return resolveNodeIdentity(cfg, {
      fallbackHost: hostname(),
      user: process.env.USER || process.env.LOGNAME,
    });
  } catch {}
  return resolveNodeIdentity({}, { fallbackHost: hostname(), user: process.env.USER || process.env.LOGNAME });
}

/**
 * Look up the nickname for the local oracle (#643 Phase 2).
 *
 * Resolution: read-through cache keyed by node name, with cwd's
 * `ψ/nickname` as on-disk fallback (the maw-js server runs from the
 * oracle repo, so cwd == local oracle repo in the common case).
 * Any error → omit silently; nickname is strictly cosmetic.
 */
function readLocalNickname(node: string): string | undefined {
  try {
    const v = resolveNickname(node, process.cwd());
    return v ?? undefined;
  } catch {
    return undefined;
  }
}

export function buildInfo(): InfoResponse {
  const identity = readIdentity();
  const node = identity.node;
  const nickname = readLocalNickname(node);
  const resp: InfoResponse = {
    node,
    ...(identity.host !== node ? { host: identity.host } : {}),
    ...(identity.user ? { user: identity.user } : {}),
    ...(identity.port !== undefined ? { port: identity.port } : {}),
    version: readVersion(),
    ts: new Date().toISOString(),
    maw: {
      schema: "1",
      plugins: {
        manifestEndpoint: "/api/plugins",
      },
      capabilities: ["plugin.listManifest", "peer.handshake", "info"],
    },
  };
  if (nickname) resp.nickname = nickname;
  return resp;
}

export const infoView = new Hono();
infoView.get("/", (c) => c.json(buildInfo()));
