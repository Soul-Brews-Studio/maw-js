import type { FeedEvent, FeedEventType } from "./feed";

export type MessageDirection = "outbound" | "inbound" | "forwarded";
export type MessageState = "queued" | "delivered" | "failed";
export type MessageChannel = "hey" | "send" | "api-send" | "plugin";
export type MessageRoute = "local" | "peer" | "discovery" | "self-node" | "team" | string;

export interface MessageLifecycleData {
  id: string;
  ts: string;
  direction: MessageDirection;
  state: MessageState;
  channel: MessageChannel;
  route: MessageRoute;
  from: string;
  to: string;
  target?: string;
  peerUrl?: string;
  text: string;
  error?: string;
  lastLine?: string;
  signed?: boolean;
}

export type MessageLifecycleInput = Omit<MessageLifecycleData, "id" | "ts"> & {
  id?: string;
  ts?: string | number | Date;
};

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isoTs(ts: MessageLifecycleInput["ts"]): string {
  if (ts instanceof Date) return ts.toISOString();
  if (typeof ts === "number") return new Date(ts).toISOString();
  if (typeof ts === "string" && ts.trim()) return ts;
  return new Date().toISOString();
}

function parseIdentity(value: string): { host: string; oracle: string } {
  const idx = value.indexOf(":");
  if (idx > 0 && idx < value.length - 1) {
    return { host: value.slice(0, idx), oracle: value.slice(idx + 1) };
  }
  return { host: "local", oracle: value || "unknown" };
}

function eventTypeFor(input: MessageLifecycleInput): FeedEventType {
  if (input.state === "failed") return "MessageFail";
  if (input.direction === "outbound") return "MessageSend";
  return "MessageDeliver";
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function buildMessageLifecycleData(input: MessageLifecycleInput): MessageLifecycleData {
  return {
    id: input.id ?? randomId(),
    ts: isoTs(input.ts),
    direction: input.direction,
    state: input.state,
    channel: input.channel,
    route: input.route,
    from: input.from,
    to: input.to,
    ...(input.target ? { target: input.target } : {}),
    ...(input.peerUrl ? { peerUrl: input.peerUrl } : {}),
    text: truncate(input.text, 2_000) ?? "",
    ...(input.error ? { error: truncate(input.error, 1_000) } : {}),
    ...(input.lastLine ? { lastLine: truncate(input.lastLine, 1_000) } : {}),
    ...(input.signed !== undefined ? { signed: input.signed } : {}),
  };
}

export function buildMessageLifecycleFeedEvent(input: MessageLifecycleInput): FeedEvent {
  const data = buildMessageLifecycleData(input);
  const identity = parseIdentity(data.direction === "inbound" ? data.to : data.from);
  const timestamp = data.ts;
  const ts = new Date(timestamp).getTime() || Date.now();
  const message = [
    `${data.direction}/${data.state}`,
    `${data.from} → ${data.to}`,
    data.target ? `(${data.target})` : "",
    data.error ? `error=${data.error}` : data.text.slice(0, 200),
  ].filter(Boolean).join(" ");

  return {
    timestamp,
    oracle: identity.oracle,
    host: identity.host,
    event: eventTypeFor(data),
    project: "",
    sessionId: data.target ?? "",
    message,
    ts,
    data,
  };
}

export function isMessageLifecycleData(value: unknown): value is MessageLifecycleData {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string"
    && typeof v.ts === "string"
    && (v.direction === "outbound" || v.direction === "inbound" || v.direction === "forwarded")
    && (v.state === "queued" || v.state === "delivered" || v.state === "failed")
    && typeof v.channel === "string"
    && typeof v.route === "string"
    && typeof v.from === "string"
    && typeof v.to === "string"
    && typeof v.text === "string";
}
