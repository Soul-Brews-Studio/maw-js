import { randomBytes } from "crypto";
import type { ServeHookContext } from "../../../core/serve-route-registry";
import type { ServeWsData, ServeWsRouteRegistrar, ServeWsSocket } from "../../../core/serve-ws-registry";
import { getShare, verifyShare } from "../share/impl";

const MAX_NAME_CHARS = 48;
const MAX_VIEWERS_PER_SLUG = 256;

export type ViewerInfo = { id: string; name: string; joinedAt: number };
export type PresenceSnapshot = { type: "presence"; slug: string; count: number; viewers: ViewerInfo[] };

type PresenceWsData = ServeWsData & {
  shareSlug?: string;
  shareToken?: string;
  viewerName?: string;
  shareError?: string;
};

type PresenceOpenState = {
  slug: string;
  viewerId: string | null;
  closing: boolean;
};

type PresenceSocket = Pick<ServeWsSocket, "send">;

type PresenceEntry = {
  viewers: Map<string, ViewerInfo>;
  sockets: Map<string, PresenceSocket>;
};

const registry = new Map<string, PresenceEntry>();
const openStates = new Map<ServeWsSocket, PresenceOpenState>();

type PresenceDeps = {
  verifyShare: (slug: string, token: string) => Promise<boolean> | boolean;
};

let deps: PresenceDeps = { verifyShare };

export function setPresenceDepsForTests(next: Partial<PresenceDeps>): () => void {
  const previous = deps;
  deps = { ...deps, ...next };
  return () => { deps = previous; };
}

function makeViewerId(): string {
  return `v_${randomBytes(9).toString("base64url")}`;
}

export function sanitizeViewerName(input: string | null | undefined): string {
  const stripped = (input ?? "")
    .replace(/[\0\x01-\x1F\x7F]/g, "")
    .trim();
  const chars = [...stripped].slice(0, MAX_NAME_CHARS).join("");
  return chars || "anonymous";
}

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

function snapshot(slug: string, entry: PresenceEntry): PresenceSnapshot {
  return {
    type: "presence",
    slug,
    count: entry.viewers.size,
    viewers: [...entry.viewers.values()],
  };
}

function sendSnapshot(slug: string, entry: PresenceEntry): void {
  const payload = JSON.stringify(snapshot(slug, entry));
  for (const socket of entry.sockets.values()) socket.send(payload);
}

export function joinPresence(slug: string, socket: PresenceSocket, name: string, now = Date.now()): ViewerInfo | { error: "too_many_viewers" } {
  let entry = registry.get(slug);
  if (!entry) {
    entry = { viewers: new Map(), sockets: new Map() };
    registry.set(slug, entry);
  }
  if (entry.viewers.size >= MAX_VIEWERS_PER_SLUG) return { error: "too_many_viewers" };
  const viewer: ViewerInfo = { id: makeViewerId(), name: sanitizeViewerName(name), joinedAt: now };
  entry.viewers.set(viewer.id, viewer);
  entry.sockets.set(viewer.id, socket);
  sendSnapshot(slug, entry);
  return viewer;
}

export function leavePresence(slug: string, viewerId: string): void {
  const entry = registry.get(slug);
  if (!entry) return;
  entry.viewers.delete(viewerId);
  entry.sockets.delete(viewerId);
  if (entry.viewers.size === 0) {
    registry.delete(slug);
    return;
  }
  sendSnapshot(slug, entry);
}

export function presenceSnapshot(slug: string): PresenceSnapshot | null {
  const entry = registry.get(slug);
  return entry ? snapshot(slug, entry) : null;
}

export function clearPresenceRegistryForTests(): void {
  registry.clear();
  openStates.clear();
  deps = { verifyShare };
}

export function openPresenceStateCountForTests(): number {
  return openStates.size;
}

function presenceWsRouteData(req: Request): PresenceWsData {
  const url = new URL(req.url);
  const params = parseRoutePart(url.pathname, "/ws/share/:slug/presence");
  return {
    target: null,
    previewTargets: new Set(),
    shareSlug: params?.slug,
    shareToken: parseShareToken(req),
    viewerName: url.searchParams.get("name") ?? undefined,
    shareError: params?.slug ? undefined : "missing slug",
  };
}

async function openPresenceWebSocket(ws: ServeWsSocket): Promise<void> {
  const data = ws.data as PresenceWsData;
  const slug = data.params?.slug || data.shareSlug || "";
  if (data.shareError || !slug) {
    ws.close(1008, data.shareError || "invalid share presence route");
    return;
  }
  const share = getShare(slug);
  if (!share) {
    ws.close(1008, "invalid or expired share token");
    return;
  }
  openStates.set(ws, { slug, viewerId: null, closing: false });
  const verified = await deps.verifyShare(slug, data.shareToken ?? "");
  const state = openStates.get(ws);
  if (!state || state.closing) {
    openStates.delete(ws);
    return;
  }
  if (!verified) {
    openStates.delete(ws);
    ws.close(1008, "invalid or expired share token");
    return;
  }
  if (share.presence !== true) {
    openStates.delete(ws);
    ws.close(1008, "share presence not enabled");
    return;
  }
  const joined = joinPresence(slug, ws, data.viewerName ?? "");
  if ("error" in joined) {
    openStates.delete(ws);
    ws.close(1013, "too many presence viewers");
    return;
  }
  state.viewerId = joined.id;
}

export async function serve(ctx: ServeHookContext & { ws?: ServeWsRouteRegistrar }): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!ctx.ws) return { ok: false, error: "share-presence requires ctx.ws" };
  ctx.ws.route("/ws/share/:slug/presence", presenceWsRouteData, {
    open: (ws) => { void openPresenceWebSocket(ws); },
    close: (ws) => {
      const state = openStates.get(ws);
      if (!state) return;
      state.closing = true;
      openStates.delete(ws);
      if (state.viewerId) leavePresence(state.slug, state.viewerId);
    },
  });
  return { ok: true };
}
