import type { FeedEvent } from "maw-js/lib/feed";
import { isMessageLifecycleData, type MessageDirection, type MessageState } from "maw-js/lib/message-events";
import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { listMessageLedgerEvents, messageLedgerDbPath, recordMessageLedgerEvent, type MessageLedgerQuery } from "./ledger";

const ENGINE_PREFIX = "/api/message-ledger";
const ENGINE_EVENTS = ["MessageSend", "MessageDeliver", "MessageFail"];

export const command = {
  name: "messages",
  description: "Query the SQLite-backed maw hey/message lifecycle ledger.",
};

export async function onEvent(event: Readonly<FeedEvent>): Promise<void> {
  if (event.event !== "MessageSend" && event.event !== "MessageDeliver" && event.event !== "MessageFail") return;
  if (!isMessageLifecycleData(event.data)) return;
  recordMessageLedgerEvent(event.data);
}

function cliArgs(ctx: InvokeContext): string[] {
  return ctx.source === "cli" && Array.isArray(ctx.args) ? ctx.args : [];
}

function argsObject(ctx: InvokeContext): Record<string, unknown> {
  return ctx.source === "api" && ctx.args && !Array.isArray(ctx.args)
    ? ctx.args as Record<string, unknown>
    : {};
}

function readOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function boolish(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return false;
}

function direction(value: unknown): MessageDirection | undefined {
  return value === "outbound" || value === "inbound" || value === "forwarded" ? value : undefined;
}

function state(value: unknown): MessageState | undefined {
  return value === "queued" || value === "delivered" || value === "failed" ? value : undefined;
}

function numberOption(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function queryFrom(ctx: InvokeContext): MessageLedgerQuery & { json: boolean } {
  const args = cliArgs(ctx);
  const query = argsObject(ctx);
  const limitRaw = readOption(args, "--limit") ?? query.limit;
  return {
    limit: limitRaw ? Number(limitRaw) : 20,
    from: readOption(args, "--from") ?? (typeof query.from === "string" ? query.from : undefined),
    to: readOption(args, "--to") ?? (typeof query.to === "string" ? query.to : undefined),
    direction: direction(readOption(args, "--direction") ?? query.direction),
    state: state(readOption(args, "--state") ?? query.state),
    q: readOption(args, "--q") ?? (typeof query.q === "string" ? query.q : undefined),
    json: args.includes("--json") || boolish(query.json) || ctx.source === "api",
  };
}

function queryFromUrl(url: URL): MessageLedgerQuery {
  return {
    limit: numberOption(url.searchParams.get("limit")) ?? 100,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    direction: direction(url.searchParams.get("direction")),
    state: state(url.searchParams.get("state")),
    q: url.searchParams.get("q") ?? undefined,
  };
}

function emit(ctx: InvokeContext, logs: string[], line: string): void {
  if (ctx.writer) ctx.writer(line);
  else logs.push(line);
}

function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function short(value: string, max = 90): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function engineUrlFromArgs(args: string[]): string {
  const raw = readOption(args, "--engine") ?? process.env.MAW_ENGINE_URL ?? `http://127.0.0.1:${process.env.MAW_PORT || "3456"}`;
  return raw.replace(/\/+$/, "");
}

function parsePort(args: string[]): number {
  const raw = readOption(args, "--port") ?? process.env.MAW_MESSAGES_PORT ?? "0";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port: ${raw}`);
  }
  return port;
}

function isRecordableMessageEvent(event: unknown): event is FeedEvent {
  if (!event || typeof event !== "object") return false;
  const e = event as FeedEvent;
  return ENGINE_EVENTS.includes(e.event) && isMessageLifecycleData(e.data);
}

export async function messagesEngineFetch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") {
    return Response.json({ ok: true, plugin: "messages", dbPath: messageLedgerDbPath() });
  }
  if (req.method === "POST" && url.pathname === "/events") {
    const event = await req.json().catch(() => null);
    const recorded = isRecordableMessageEvent(event);
    if (recorded) recordMessageLedgerEvent(event.data);
    return Response.json({ ok: true, recorded });
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/messages")) {
    const messages = listMessageLedgerEvents(queryFromUrl(url));
    return Response.json({ ok: true, messages, total: messages.length, source: "sqlite", dbPath: messageLedgerDbPath() });
  }
  return Response.json({ ok: false, error: "not_found" }, { status: 404 });
}

async function registerWithEngine(engineUrl: string, upstream: string): Promise<void> {
  const response = await fetch(`${engineUrl}/api/_engine/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      plugin: "messages",
      prefix: ENGINE_PREFIX,
      upstream,
      events: ENGINE_EVENTS,
      eventPath: "/events",
      health: "/health",
    }),
  });
  if (!response.ok) {
    throw new Error(`engine register failed ${response.status}: ${await response.text()}`);
  }
}

async function unregisterFromEngine(engineUrl: string): Promise<void> {
  await fetch(`${engineUrl}/api/_engine/unregister`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plugin: "messages", prefix: ENGINE_PREFIX }),
  }).catch(() => undefined);
}

async function serveEngine(ctx: InvokeContext, args: string[]): Promise<InvokeResult> {
  const logs: string[] = [];
  const engineUrl = engineUrlFromArgs(args);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: parsePort(args),
    fetch: messagesEngineFetch,
  });
  const upstream = `http://127.0.0.1:${server.port}`;

  try {
    await registerWithEngine(engineUrl, upstream);
  } catch (err) {
    server.stop(true);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  emit(ctx, logs, `maw messages serve → ${upstream} (registered ${ENGINE_PREFIX} on ${engineUrl})`);
  emit(ctx, logs, `events: ${ENGINE_EVENTS.join(", ")} → /events`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    unregisterFromEngine(engineUrl).finally(() => {
      server.stop(true);
      process.exit(0);
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await new Promise(() => undefined);
  return { ok: true, output: logs.join("\n") };
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult & Record<string, unknown>> {
  const logs: string[] = [];
  const args = cliArgs(ctx);
  if (args[0] === "serve") return serveEngine(ctx, args.slice(1));

  const query = queryFrom(ctx);
  const rows = listMessageLedgerEvents(query);
  const payload = { ok: true, messages: rows, total: rows.length, dbPath: messageLedgerDbPath() };

  if (query.json) {
    return { ...payload, output: JSON.stringify(payload, null, 2) };
  }

  if (rows.length === 0) {
    emit(ctx, logs, `no messages recorded (${messageLedgerDbPath()})`);
    return { ok: true, output: logs.join("\n") };
  }

  emit(ctx, logs, `message ledger: ${rows.length} row${rows.length === 1 ? "" : "s"} (${messageLedgerDbPath()})`);
  for (const row of rows) {
    const arrow = row.direction === "inbound" ? "←" : row.direction === "forwarded" ? "↝" : "→";
    const status = row.state === "failed" ? "✗" : row.state === "queued" ? "…" : "✓";
    const route = `${row.direction}/${row.route}/${row.state}`;
    emit(ctx, logs, `${fmtTime(row.ts)}  ${status} ${route}  ${row.from} ${arrow} ${row.to}  ${short(row.text.replace(/\s+/g, " "))}`);
    if (row.error) emit(ctx, logs, `  error: ${short(row.error)}`);
    if (row.lastLine) emit(ctx, logs, `  ⤷ ${short(row.lastLine)}`);
  }
  return { ok: true, output: logs.join("\n") };
}
