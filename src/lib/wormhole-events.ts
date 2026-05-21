import type { FeedEvent, FeedEventType } from "./feed";

export type WormholeDirection = "inbound" | "outbound" | "relayed";
export type WormholeState = "queued" | "delivered" | "failed";
export type WormholeTrustTier = "readonly" | "shell_allowlisted" | "denied";

export interface WormholeLifecycleData {
  id: string;
  ts: string;
  direction: WormholeDirection;
  state: WormholeState;
  cmd: string;
  args: string[];
  origin: string;
  peer: string;
  peerUrl?: string;
  trustTier: WormholeTrustTier;
  elapsedMs?: number;
  status?: number;
  outputBytes?: number;
  error?: string;
}

export type WormholeLifecycleInput = Omit<WormholeLifecycleData, "id" | "ts"> & {
  id?: string;
  ts?: string | number | Date;
};

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isoTs(ts: WormholeLifecycleInput["ts"]): string {
  if (ts instanceof Date) return ts.toISOString();
  if (typeof ts === "number") return new Date(ts).toISOString();
  if (typeof ts === "string" && ts.trim()) return ts;
  return new Date().toISOString();
}

function parseIdentity(value: string): { host: string; oracle: string } {
  // Origin signatures arrive bracketed: "[host:agent]". Strip outer brackets first.
  const stripped = value.replace(/^\[/, "").replace(/\]$/, "");
  const idx = stripped.indexOf(":");
  if (idx > 0 && idx < stripped.length - 1) {
    return { host: stripped.slice(0, idx), oracle: stripped.slice(idx + 1) };
  }
  return { host: "local", oracle: stripped || "unknown" };
}

function eventTypeFor(input: WormholeLifecycleInput): FeedEventType {
  if (input.state === "failed") return "WormholeFail";
  return "WormholeRequest";
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function buildWormholeLifecycleData(input: WormholeLifecycleInput): WormholeLifecycleData {
  return {
    id: input.id ?? randomId(),
    ts: isoTs(input.ts),
    direction: input.direction,
    state: input.state,
    cmd: truncate(input.cmd, 500) ?? "",
    args: Array.isArray(input.args)
      ? input.args.slice(0, 50).map((arg) => truncate(String(arg), 500) ?? "")
      : [],
    origin: input.origin,
    peer: input.peer,
    ...(input.peerUrl ? { peerUrl: input.peerUrl } : {}),
    trustTier: input.trustTier,
    ...(input.elapsedMs !== undefined ? { elapsedMs: input.elapsedMs } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.outputBytes !== undefined ? { outputBytes: input.outputBytes } : {}),
    ...(input.error ? { error: truncate(input.error, 1_000) } : {}),
  };
}

export function buildWormholeLifecycleFeedEvent(input: WormholeLifecycleInput): FeedEvent {
  const data = buildWormholeLifecycleData(input);
  const identity = parseIdentity(data.origin);
  const timestamp = data.ts;
  const ts = new Date(timestamp).getTime() || Date.now();
  const message = [
    `${data.direction}/${data.state}`,
    `${data.origin} → ${data.peer}`,
    `cmd=${data.cmd}`,
    `tier=${data.trustTier}`,
    data.status !== undefined ? `status=${data.status}` : "",
    data.error ? `error=${data.error}` : "",
  ].filter(Boolean).join(" ");

  return {
    timestamp,
    oracle: identity.oracle,
    host: identity.host,
    event: eventTypeFor(data),
    project: "",
    sessionId: data.peer,
    message,
    ts,
    data,
  };
}

export function isWormholeLifecycleData(value: unknown): value is WormholeLifecycleData {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string"
    && typeof v.ts === "string"
    && (v.direction === "inbound" || v.direction === "outbound" || v.direction === "relayed")
    && (v.state === "queued" || v.state === "delivered" || v.state === "failed")
    && typeof v.cmd === "string"
    && Array.isArray(v.args)
    && typeof v.origin === "string"
    && typeof v.peer === "string"
    && (v.trustTier === "readonly" || v.trustTier === "shell_allowlisted" || v.trustTier === "denied");
}
