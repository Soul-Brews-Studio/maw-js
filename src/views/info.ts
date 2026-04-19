import { Hono } from "hono";
import { hostname } from "os";
import { readFileSync } from "fs";
import { join } from "path";
import { loadConfig } from "../config";
import { resolveNickname } from "../core/fleet/nicknames";

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

function readNode(): string {
  try {
    const cfg = loadConfig();
    if (typeof cfg.node === "string" && cfg.node) return cfg.node;
  } catch {}
  return hostname();
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
  const node = readNode();
  const nickname = readLocalNickname(node);
  const resp: InfoResponse = {
    node,
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
