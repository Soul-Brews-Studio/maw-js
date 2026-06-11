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

const SHARE_USAGE = "usage: maw share <session-or-pane> [--read-only] [--ttl <seconds>] [--port <number>] [--auth token|federation|none]";
const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_READ_ONLY = true;

type ShareAuth = "token" | "federation" | "none";

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
  return url.searchParams.get("token") || url.searchParams.get("t") || "";
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
  return fromFlag || loadConfig().port || 3456;
}

function resolveAuthFlag(raw: unknown): ShareAuth {
  if (typeof raw !== "string") return "token";
  const maybe = raw.toLowerCase();
  if (maybe === "token" || maybe === "federation" || maybe === "none") return maybe;
  throw new Error(`invalid --auth '${raw}', expected one of token|federation|none`);
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
    }, 0);

    const target = flags._[0];
    if (!target || target === "--help" || target === "-h") {
      return { ok: false, error: `${SHARE_USAGE}` };
    }
    if (target.startsWith("-")) {
      return { ok: false, error: `${SHARE_USAGE}\n  target looks like a flag` };
    }

    const hit = resolveTmuxTarget(target);
    if (!hit) {
      return { ok: false, error: `cannot resolve tmux target: ${target}` };
    }

    const readOnly = flags["--read-only"] === undefined ? DEFAULT_READ_ONLY : Boolean(flags["--read-only"]);
    const ttl = typeof flags["--ttl"] === "number" && Number.isFinite(flags["--ttl"]) ? flags["--ttl"] : DEFAULT_TTL_SECONDS;
    const auth = resolveAuthFlag(flags["--auth"]);

    const { slug, token } = await createShare({
      target: hit.resolved,
      readOnly,
      ttl,
      auth,
    });

    const host = loadConfig().host || "localhost";
    const port = daemonPortFromFlags(flags);
    const url = `http://${host}:${port}/share/${slug}#t=${token}`;
    console.log(`🔗 ${url}`);
    return { ok: true, output: url };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}
