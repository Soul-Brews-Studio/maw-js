import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "maw-js/config";
import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { parseFlags } from "maw-js/cli/parse-args";
import { resolveTmuxTarget } from "../../../commands/plugins/tmux/impl";
import type { ServeHookContext } from "../../../core/serve-route-registry";
import type { ServeWsData, ServeWsSocket } from "../../../core/serve-ws-registry";
import { createShare, getShare, verifyShare, type Share } from "./impl";
import { attach, type ShareStreamHandle } from "./stream";

export const command = {
  name: "share",
  description: "Share a live read-only tmux session/pane in a browser via a temporary link.",
};

const SHARE_USAGE = "usage: maw share <session-or-pane> [additional-pane ...] [--read-only] [--ttl <seconds>] [--port <number>] [--auth token|federation|none|encrypted] [--encrypt]";
const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_READ_ONLY = true;

type ShareAuth = "token" | "federation" | "none" | "encrypted";

type ShareWsData = ServeWsData & {
  shareSlug?: string;
  shareToken?: string;
  shareError?: string;
};

type ShareOpenState = {
  slug: string;
  handle: ShareStreamHandle;
};

type ShareMetadata = {
  target: string;
  panes: string[];
  readOnly: boolean;
  expiresAt: number;
  auth: string;
};

type CreateShareRequest = {
  target?: unknown;
  panes?: unknown;
  readOnly?: unknown;
  ttl?: unknown;
  auth?: unknown;
  encrypted?: unknown;
};

const viewerHtml = (() => {
  const p = join(import.meta.dir, "viewer.html");
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
})();

function parseRoutePart(pathname: string, pattern: string): Record<string, string> | null {
  const pathParts = pathname.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);
  if (pathParts.length !== patternParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const part = patternParts[i];
    const actual = pathParts[i];
    if (actual === undefined) return null;
    if (part.startsWith(":")) {
      params[part.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (part !== actual) return null;
  }

  return params;
}

function parseShareToken(req: Request): string {
  const url = new URL(req.url);
  return url.searchParams.get("token") || url.searchParams.get("t") || url.searchParams.get("h") || "";
}

function getShareSlugFromWsData(data: ShareWsData): string | null {
  return data.params?.slug || data.shareSlug || null;
}

function isPingMessage(message: unknown): boolean {
  if (typeof message === "string") return message.trim().toLowerCase() === "ping";
  if (ArrayBuffer.isView(message)) {
    const text = new TextDecoder().decode(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
    return text.trim().toLowerCase() === "ping";
  }
  if (message instanceof ArrayBuffer) {
    const text = new TextDecoder().decode(new Uint8Array(message));
    return text.trim().toLowerCase() === "ping";
  }
  return false;
}

async function openShareWebSocket(
  ws: ServeWsSocket,
  states: Map<ServeWsSocket, ShareOpenState>,
): Promise<void> {
  const data = ws.data as ShareWsData;
  const slug = getShareSlugFromWsData(data);
  const token = data.shareToken ?? "";

  if (!slug) {
    ws.close(1008, "invalid share route");
    return;
  }

  const share = getShare(slug);
  if (!share || !(await verifyShare(slug, token))) {
    ws.close(1008, "invalid or expired share token");
    return;
  }

  try {
    const handle = await attach(share, ws);
    states.set(ws, { slug, handle });
  } catch (error: unknown) {
    ws.close(1011, error instanceof Error ? error.message : "share stream failed");
  }
}

function shareUrlForRequest(req: Request, slug: string, token: string, encrypted: boolean): string {
  const url = new URL(req.url);
  const param = encrypted ? "k" : "t";
  return `${url.origin}/share/${slug}#${param}=${token}`;
}

async function parseJsonRequest(req: Request): Promise<CreateShareRequest> {
  try {
    const data = await req.json();
    return data && typeof data === "object" ? data as CreateShareRequest : {};
  } catch {
    return {};
  }
}

async function routeCreateShare(req: Request): Promise<Response> {
  const body = await parseJsonRequest(req);
  if (typeof body.target !== "string" || body.target.trim() === "") {
    return new Response(JSON.stringify({ error: "target_required" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  try {
    const created = await createShare({
      target: body.target,
      panes: Array.isArray(body.panes) ? body.panes.filter((pane): pane is string => typeof pane === "string") : undefined,
      readOnly: body.readOnly === undefined ? DEFAULT_READ_ONLY : body.readOnly !== false,
      ttl: typeof body.ttl === "number" && Number.isFinite(body.ttl) ? body.ttl : DEFAULT_TTL_SECONDS,
      auth: resolveAuthFlag(body.auth),
      encrypted: body.encrypted === true || body.auth === "encrypted",
    });
    const payload = {
      slug: created.slug,
      token: created.token,
      encrypted: created.encrypted === true,
      url: shareUrlForRequest(req, created.slug, created.token, created.encrypted === true),
    };
    return new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (error: unknown) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}

function routeShareHtml(req: Request): Response {
  const params = parseRoutePart(new URL(req.url).pathname, "/share/:slug");
  const slug = params?.slug;
  if (!slug) {
    return new Response("Not Found", { status: 404 });
  }

  const share = getShare(slug);
  if (!share) {
    return new Response("Share not found", { status: 404 });
  }

  return new Response(viewerHtml, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function routeShareMetadata(req: Request): Promise<Response> {
  const params = parseRoutePart(new URL(req.url).pathname, "/api/share/:slug");
  const slug = params?.slug;
  if (!slug) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const token = parseShareToken(req);
  const share = getShare(slug);
  if (!share || !(await verifyShare(slug, token))) {
    return new Response(JSON.stringify({ error: "invalid_share" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const payload: ShareMetadata = {
    target: share.target,
    panes: share.panes,
    readOnly: share.readOnly,
    expiresAt: share.expiresAt,
    auth: share.auth,
  };

  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function shareWsRouteData(req: Request): ShareWsData {
  const params = parseRoutePart(new URL(req.url).pathname, "/ws/share/:slug");
  return {
    target: null,
    previewTargets: new Set(),
    shareSlug: params?.slug,
    shareToken: parseShareToken(req),
    shareError: params?.slug ? undefined : "missing slug",
  };
}

export async function serve(ctx: ServeHookContext): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!ctx.http) return { ok: false, error: "share serve requires ctx.http" };

  const registerJson = async () => {
    ctx.http.route("POST", "/api/share", routeCreateShare);
    ctx.http.route("GET", "/share/:slug", routeShareHtml);
    ctx.http.route("GET", "/api/share/:slug", routeShareMetadata);
  };

  await registerJson();

  if (!ctx.ws) return { ok: true };

  const openStreams = new Map<ServeWsSocket, ShareOpenState>();
  ctx.ws.route("/ws/share/:slug", shareWsRouteData, {
    open: (ws) => {
      const data = ws.data as ShareWsData;
      if (data.shareError) {
        ws.close(1008, data.shareError);
        return;
      }
      void openShareWebSocket(ws, openStreams);
    },
    message: (ws, message) => {
      const state = openStreams.get(ws);
      if (state?.handle && isPingMessage(message)) {
        ws.send("pong");
        return;
      }
      if (!state) return;
      state.handle.onMessage(message);
    },
    close: (ws) => {
      const state = openStreams.get(ws);
      if (!state) return;
      void state.handle.close();
      openStreams.delete(ws);
    },
  });

  return { ok: true };
}

function daemonPortFromFlags(flags: Record<string, unknown>): number {
  const fromFlag = typeof flags["--port"] === "number" && Number.isFinite(flags["--port"])
    ? Number(flags["--port"])
    : undefined;
  return fromFlag || loadConfig().port || 3457;
}

function resolveAuthFlag(raw: unknown): ShareAuth {
  if (typeof raw !== "string") return "token";
  const maybe = raw.toLowerCase();
  if (maybe === "token" || maybe === "federation" || maybe === "none" || maybe === "encrypted") return maybe;
  throw new Error(`invalid --auth '${raw}', expected one of token|federation|none|encrypted`);
}

function daemonLoopbackOrigin(flags: Record<string, unknown>): string {
  const port = daemonPortFromFlags(flags);
  return `http://127.0.0.1:${port}`;
}

function formatDisplayHost(host: string): string {
  if (host.includes("://")) {
    throw new Error(`share display URL requires config.host without protocol, got '${host}'`);
  }
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    throw new Error(`share display URL requires a reachable config.host, got bind-only host '${host}'`);
  }
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
  return host;
}

export function displayOriginForHost(host: string | undefined, port: number): string {
  if (!host) throw new Error("share display URL requires config.host");
  return `http://${formatDisplayHost(host)}:${port}`;
}

export function displayOrigin(flags: Record<string, unknown>): string {
  const { host } = loadConfig();
  const port = daemonPortFromFlags(flags);
  return displayOriginForHost(host, port);
}

function displayShareUrl(origin: string, share: { slug: string; token: string; encrypted?: boolean }): string {
  const param = share.encrypted === true ? "k" : "t";
  return `${origin}/share/${share.slug}#${param}=${share.token}`;
}

export async function createShareViaDaemon(origin: string, body: CreateShareRequest): Promise<{ slug: string; token: string; encrypted?: boolean }> {
  const endpoint = `${origin}/api/share`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`share daemon request failed at ${endpoint}: ${message}; is 'maw serve' running on this port?`);
  }
  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    // keep null payload; status branch below reports HTTP code
  }
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`share daemon at ${origin} does not expose /api/share (HTTP 404); ensure maw serve is running with the share plugin loaded`);
    }
    throw new Error(payload?.error || `share daemon at ${origin} returned HTTP ${res.status}`);
  }
  if (!payload || typeof payload.slug !== "string" || typeof payload.token !== "string") {
    throw new Error("share daemon returned an invalid response");
  }
  return payload;
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  try {
    if (ctx.source !== "cli") {
      return { ok: false, error: "share currently supports CLI usage only" };
    }

    const flags = parseFlags(ctx.args as string[], {
      "--read-only": Boolean,
      "--ttl": Number,
      "--port": Number,
      "--auth": String,
      "--encrypt": Boolean,
    }, 0);

    const targets = flags._;
    const target = targets[0];
    if (!target || target === "--help" || target === "-h") {
      return { ok: false, error: `${SHARE_USAGE}` };
    }
    if (targets.some((candidate) => candidate.startsWith("-"))) {
      return { ok: false, error: `${SHARE_USAGE}\n  target looks like a flag` };
    }

    const hits = targets.map((candidate) => ({ candidate, hit: resolveTmuxTarget(candidate) }));
    const missing = hits.find((entry) => !entry.hit);
    if (missing) {
      return { ok: false, error: `cannot resolve tmux target: ${missing.candidate}` };
    }
    const resolvedTargets = hits.map((entry) => entry.hit!.resolved);
    const hit = hits[0]!.hit!;

    const readOnly = flags["--read-only"] === undefined ? DEFAULT_READ_ONLY : Boolean(flags["--read-only"]);
    const ttl = typeof flags["--ttl"] === "number" && Number.isFinite(flags["--ttl"]) ? flags["--ttl"] : DEFAULT_TTL_SECONDS;
    const encrypted = flags["--encrypt"] === true || flags["--auth"] === "encrypted";
    const auth = encrypted && flags["--auth"] === undefined ? "encrypted" : resolveAuthFlag(flags["--auth"]);

    const request: CreateShareRequest = {
      target: hit.resolved,
      panes: resolvedTargets.length > 1 ? resolvedTargets : undefined,
      readOnly,
      ttl,
      auth,
    };
    if (encrypted) request.encrypted = true;

    const share = await createShareViaDaemon(daemonLoopbackOrigin(flags), request);
    const url = displayShareUrl(displayOrigin(flags), share);

    console.log(`🔗 ${url}`);
    return { ok: true, output: url };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}
