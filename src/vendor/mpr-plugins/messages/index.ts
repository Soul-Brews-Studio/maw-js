import type { FeedEvent } from "maw-js/lib/feed";
import { isMessageLifecycleData, type MessageDirection, type MessageState } from "maw-js/lib/message-events";
import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { listMessageLedgerEvents, messageLedgerDbPath, recordMessageLedgerEvent, type MessageLedgerQuery } from "./ledger";

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

export default async function handler(ctx: InvokeContext): Promise<InvokeResult & Record<string, unknown>> {
  const logs: string[] = [];
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
