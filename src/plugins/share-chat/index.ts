import { randomBytes } from "crypto";
import type { ServeHookContext } from "../../../core/serve-route-registry";
import type { ServeWsData, ServeWsRouteRegistrar, ServeWsSocket } from "../../../core/serve-ws-registry";
import { getShare, verifyShare } from "../share/impl";

const MAX_NAME_CHARS = 48;
const MAX_TEXT_CHARS = 2_000;
const MAX_CHAT_VIEWERS_PER_SLUG = 256;

export type ChatMessage = {
  type: "chat";
  slug: string;
  id: string;
  viewerId: string;
  name: string;
  text: string;
  sentAt: number;
};

export type ChatReady = { type: "chat-ready"; slug: string; viewerId: string; name: string };

type ChatWsData = ServeWsData & {
  shareSlug?: string;
  shareToken?: string;
  viewerName?: string;
  shareError?: string;
};

type ChatOpenState = {
  slug: string;
  viewerId: string | null;
  name: string;
  closing: boolean;
};

type ChatSocket = Pick<ServeWsSocket, "send">;

type ChatEntry = {
  viewers: Map<string, { name: string; socket: ChatSocket }>;
};

const registry = new Map<string, ChatEntry>();
const openStates = new Map<ServeWsSocket, ChatOpenState>();

type ChatDeps = {
  verifyShare: (slug: string, token: string) => Promise<boolean> | boolean;
  now: () => number;
};

let deps: ChatDeps = { verifyShare, now: () => Date.now() };

export function setChatDepsForTests(next: Partial<ChatDeps>): () => void {
  const previous = deps;
  deps = { ...deps, ...next };
  return () => { deps = previous; };
}

function makeViewerId(): string {
  return `c_${randomBytes(9).toString("base64url")}`;
}

function makeMessageId(): string {
  return `m_${randomBytes(12).toString("base64url")}`;
}

export function sanitizeChatName(input: string | null | undefined): string {
  const stripped = (input ?? "")
    .replace(/[\0\x01-\x1F\x7F]/g, "")
    .trim();
  const chars = [...stripped].slice(0, MAX_NAME_CHARS).join("");
  return chars || "anonymous";
}

export function sanitizeChatText(input: unknown): string {
  const raw = typeof input === "string" ? input : "";
  const stripped = raw.replace(/[\0\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
  return [...stripped].slice(0, MAX_TEXT_CHARS).join("");
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

function chatWsRouteData(req: Request): ChatWsData {
  const url = new URL(req.url);
  const params = parseRoutePart(url.pathname, "/ws/share/:slug/chat");
  return {
    target: null,
    previewTargets: new Set(),
    shareSlug: params?.slug,
    shareToken: parseShareToken(req),
    viewerName: url.searchParams.get("name") ?? undefined,
    shareError: params?.slug ? undefined : "missing slug",
  };
}

function joinChat(slug: string, socket: ChatSocket, name: string): ChatReady | { error: "too_many_viewers" } {
  let entry = registry.get(slug);
  if (!entry) {
    entry = { viewers: new Map() };
    registry.set(slug, entry);
  }
  if (entry.viewers.size >= MAX_CHAT_VIEWERS_PER_SLUG) return { error: "too_many_viewers" };
  const viewerId = makeViewerId();
  const ready: ChatReady = { type: "chat-ready", slug, viewerId, name: sanitizeChatName(name) };
  entry.viewers.set(viewerId, { name: ready.name, socket });
  socket.send(JSON.stringify(ready));
  return ready;
}

function leaveChat(slug: string, viewerId: string): void {
  const entry = registry.get(slug);
  if (!entry) return;
  entry.viewers.delete(viewerId);
  if (entry.viewers.size === 0) registry.delete(slug);
}

function parseChatText(message: unknown): string {
  if (typeof message === "string") {
    try {
      const parsed = JSON.parse(message) as { text?: unknown };
      if (parsed && typeof parsed === "object" && "text" in parsed) return sanitizeChatText(parsed.text);
    } catch {
      // Treat non-JSON strings as chat text for simple clients.
    }
    return sanitizeChatText(message);
  }
  if (ArrayBuffer.isView(message)) {
    return sanitizeChatText(new TextDecoder().decode(new Uint8Array(message.buffer, message.byteOffset, message.byteLength)));
  }
  if (message instanceof ArrayBuffer) return sanitizeChatText(new TextDecoder().decode(new Uint8Array(message)));
  return "";
}

function broadcastChat(slug: string, viewerId: string, text: string): ChatMessage | null {
  const entry = registry.get(slug);
  const viewer = entry?.viewers.get(viewerId);
  if (!entry || !viewer || !text) return null;
  const payload: ChatMessage = {
    type: "chat",
    slug,
    id: makeMessageId(),
    viewerId,
    name: viewer.name,
    text,
    sentAt: deps.now(),
  };
  const raw = JSON.stringify(payload);
  for (const peer of entry.viewers.values()) peer.socket.send(raw);
  return payload;
}

async function openChatWebSocket(ws: ServeWsSocket): Promise<void> {
  const data = ws.data as ChatWsData;
  const slug = data.params?.slug || data.shareSlug || "";
  if (data.shareError || !slug) {
    ws.close(1008, data.shareError || "invalid share chat route");
    return;
  }
  const share = getShare(slug);
  if (!share) {
    ws.close(1008, "invalid or expired share token");
    return;
  }
  openStates.set(ws, { slug, viewerId: null, name: sanitizeChatName(data.viewerName), closing: false });
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
  if (share.chat !== true) {
    openStates.delete(ws);
    ws.close(1008, "share chat not enabled");
    return;
  }
  const joined = joinChat(slug, ws, state.name);
  if ("error" in joined) {
    openStates.delete(ws);
    ws.close(1013, "too many chat viewers");
    return;
  }
  state.viewerId = joined.viewerId;
  state.name = joined.name;
}

export function chatViewerCount(slug: string): number {
  return registry.get(slug)?.viewers.size ?? 0;
}

export function clearChatRegistryForTests(): void {
  registry.clear();
  openStates.clear();
  deps = { verifyShare, now: () => Date.now() };
}

export function openChatStateCountForTests(): number {
  return openStates.size;
}

export async function serve(ctx: ServeHookContext & { ws?: ServeWsRouteRegistrar }): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!ctx.ws) return { ok: false, error: "share-chat requires ctx.ws" };
  ctx.ws.route("/ws/share/:slug/chat", chatWsRouteData, {
    open: (ws) => { void openChatWebSocket(ws); },
    message: (ws, message) => {
      const state = openStates.get(ws);
      if (!state?.viewerId) return;
      broadcastChat(state.slug, state.viewerId, parseChatText(message));
    },
    close: (ws) => {
      const state = openStates.get(ws);
      if (!state) return;
      state.closing = true;
      openStates.delete(ws);
      if (state.viewerId) leaveChat(state.slug, state.viewerId);
    },
  });
  return { ok: true };
}
