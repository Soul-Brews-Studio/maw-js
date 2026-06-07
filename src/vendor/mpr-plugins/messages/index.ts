import type { FeedEvent } from "maw-js/lib/feed";
import { isMessageLifecycleData, type MessageDirection, type MessageState } from "maw-js/lib/message-events";
import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { listMessageLedgerEvents, messageLedgerDbPath, recordMessageLedgerEvent, type MessageLedgerQuery } from "./ledger";
import { mawStatePath } from "../../../core/xdg";
import { spawn } from "child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

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

function supervisorDir(): string {
  return mawStatePath("engine-plugins");
}

function pidPath(): string {
  return join(supervisorDir(), "messages.pid");
}

function logPath(): string {
  return join(supervisorDir(), "messages.log");
}

function ensureSupervisorDir(): void {
  mkdirSync(supervisorDir(), { recursive: true });
}

function readPid(): number | null {
  try {
    const pid = Number(readFileSync(pidPath(), "utf-8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writePid(pid: number): void {
  ensureSupervisorDir();
  writeFileSync(pidPath(), `${pid}\n`, "utf-8");
}

function removePidFile(): void {
  try {
    unlinkSync(pidPath());
  } catch {
    // Best-effort cleanup: stale pid files should not make stop/status fail.
  }
}

function isAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

function tailLog(maxBytes = 1200): string {
  try {
    const raw = readFileSync(logPath());
    return raw.subarray(Math.max(0, raw.length - maxBytes)).toString("utf-8").trim();
  } catch {
    return "";
  }
}

function currentMawCommand(): { command: string; argsPrefix: string[] } {
  if (process.argv[0] && process.argv[1]) return { command: process.argv[0], argsPrefix: [process.argv[1]] };
  return { command: "maw", argsPrefix: [] };
}

async function engineRegistration(engineUrl: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${engineUrl}/api/_engine/registrations`, { signal: AbortSignal.timeout(1_000) });
  if (!response.ok) return null;
  const body = await response.json() as { registrations?: Array<Record<string, unknown>> };
  return body.registrations?.find((registration) => registration.plugin === "messages") ?? null;
}

async function waitForRegistration(engineUrl: string, wantPresent: boolean, timeoutMs = 2_500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const present = Boolean(await engineRegistration(engineUrl).catch(() => null));
    if (present === wantPresent) return true;
    await Bun.sleep(100);
  }
  return false;
}

async function waitForPidExit(pid: number | null, timeoutMs = 2_500): Promise<boolean> {
  if (!pid) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(100);
  }
  return !isAlive(pid);
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

const SHUTDOWN_UNREGISTER_TIMEOUT_MS = 500;
const SHUTDOWN_UNREGISTER_RETRY_MS = 50;

async function unregisterFromEngine(engineUrl: string, timeoutMs = SHUTDOWN_UNREGISTER_TIMEOUT_MS): Promise<boolean> {
  const started = Date.now();
  let attempted = false;
  while (!attempted || Date.now() - started < timeoutMs) {
    attempted = true;
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - started));
    try {
      const response = await fetch(`${engineUrl}/api/_engine/unregister`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plugin: "messages", prefix: ENGINE_PREFIX }),
        signal: AbortSignal.timeout(remainingMs),
      });
      if (response.ok) {
        const body = await response.json().catch(() => null) as { ok?: unknown; removed?: unknown } | null;
        if (body?.ok !== false && body?.removed !== false) return true;
      }
    } catch {
      // Retry until the bounded shutdown window expires.
    }
    const nextDelay = Math.min(SHUTDOWN_UNREGISTER_RETRY_MS, Math.max(0, timeoutMs - (Date.now() - started)));
    if (nextDelay <= 0) break;
    await Bun.sleep(nextDelay);
  }
  return false;
}

type ServeHandle = { stop(force?: boolean): void };

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function installServeShutdown(
  engineUrl: string,
  server: ServeHandle,
  deps: {
    once?: typeof process.once;
    unregister?: (engineUrl: string, timeoutMs?: number) => Promise<unknown>;
    exit?: typeof process.exit;
    timeoutMs?: number;
    warn?: typeof console.warn;
  } = {},
): () => Promise<void> | void {
  const once = deps.once ?? process.once.bind(process);
  const unregister = deps.unregister ?? unregisterFromEngine;
  const exit = deps.exit ?? process.exit.bind(process);
  const timeoutMs = deps.timeoutMs ?? SHUTDOWN_UNREGISTER_TIMEOUT_MS;
  const warn = deps.warn ?? console.warn.bind(console);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      const result = await withTimeout(Promise.resolve(unregister(engineUrl, timeoutMs)), timeoutMs);
      if (result === "timeout" || result === false) {
        warn(`maw messages serve: engine unregister did not confirm within ${timeoutMs}ms; exiting and relying on health pruning`);
      }
    } finally {
      server.stop(true);
      exit(0);
    }
  };
  once("SIGTERM", shutdown);
  once("SIGINT", shutdown);
  return shutdown;
}

async function serveEngine(ctx: InvokeContext, args: string[]): Promise<InvokeResult> {
  const logs: string[] = [];
  if (args.includes("--detach")) return detachEngine(ctx, args.filter((arg) => arg !== "--detach"));

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

  installServeShutdown(engineUrl, server);

  if (process.env.MAW_TEST_MODE === "1") return { ok: true, output: logs.join("\n") };

  await new Promise(() => undefined);
  return { ok: true, output: logs.join("\n") };
}

async function detachEngine(ctx: InvokeContext, args: string[]): Promise<InvokeResult> {
  const logs: string[] = [];
  const engineUrl = engineUrlFromArgs(args);
  const existingPid = readPid();
  const existingRegistration = await engineRegistration(engineUrl).catch(() => null);
  if (isAlive(existingPid) && existingRegistration) {
    return {
      ok: true,
      output: `maw messages serve already running (PID ${existingPid}, ${ENGINE_PREFIX} registered)\nlog: ${logPath()}`,
    };
  }
  if (isAlive(existingPid) && !existingRegistration) {
    try {
      process.kill(existingPid!, "SIGTERM");
    } catch {
      removePidFile();
    }
    if (!(await waitForPidExit(existingPid, 1_000))) {
      return {
        ok: false,
        error: `maw messages serve has a live PID ${existingPid} but ${ENGINE_PREFIX} is not registered on ${engineUrl}\nrun: maw messages stop --engine ${engineUrl}`,
      };
    }
    removePidFile();
  }
  if (existingPid && !isAlive(existingPid)) removePidFile();

  ensureSupervisorDir();
  const outFd = openSync(logPath(), "a");
  const childArgs = ["messages", "serve"];
  const engine = readOption(args, "--engine");
  const port = readOption(args, "--port");
  if (engine) childArgs.push("--engine", engine);
  if (port) childArgs.push("--port", port);

  const maw = currentMawCommand();
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(maw.command, [...maw.argsPrefix, ...childArgs], {
      detached: true,
      stdio: ["ignore", outFd, outFd],
      env: {
        ...process.env,
        MAW_ENGINE_URL: engineUrl,
      },
    });
  } catch (err) {
    closeSync(outFd);
    return { ok: false, error: `failed to spawn maw messages serve: ${err instanceof Error ? err.message : String(err)}` };
  }
  closeSync(outFd);
  if (!child.pid) {
    return { ok: false, error: `failed to spawn maw messages serve: no child PID\nlog: ${logPath()}` };
  }
  child.unref();
  writePid(child.pid);

  const registered = await waitForRegistration(engineUrl, true);
  if (!registered) {
    return {
      ok: false,
      error: [
        `maw messages serve --detach did not register ${ENGINE_PREFIX}`,
        `pid: ${child.pid}`,
        `log: ${logPath()}`,
        tailLog() ? `tail:\n${tailLog()}` : "",
      ].filter(Boolean).join("\n"),
    };
  }

  emit(ctx, logs, `maw messages serve detached (PID ${child.pid})`);
  emit(ctx, logs, `registered: ${ENGINE_PREFIX} on ${engineUrl}`);
  emit(ctx, logs, `log: ${logPath()}`);
  return { ok: true, output: logs.join("\n") };
}

async function statusEngine(args: string[]): Promise<InvokeResult> {
  const engineUrl = engineUrlFromArgs(args);
  const pid = readPid();
  const alive = isAlive(pid);
  const registration = await engineRegistration(engineUrl).catch(() => null);
  const lines = [
    `maw messages serve: ${alive ? "running" : "stopped"}${pid ? ` (PID ${pid})` : ""}`,
    `engine: ${engineUrl}`,
    `registered: ${registration ? `${registration.prefix ?? ENGINE_PREFIX} → ${registration.upstream ?? "unknown"}` : "no"}`,
    `db: ${messageLedgerDbPath()}`,
    `log: ${logPath()}`,
  ];
  if (!alive && pid && existsSync(pidPath())) lines.push("note: stale pid file present");
  return { ok: true, output: lines.join("\n") };
}

async function stopEngine(args: string[]): Promise<InvokeResult> {
  const engineUrl = engineUrlFromArgs(args);
  const pid = readPid();
  const lines: string[] = [];
  if (isAlive(pid)) {
    try {
      process.kill(pid!, "SIGTERM");
      lines.push(`sent SIGTERM to PID ${pid}`);
    } catch (err) {
      lines.push(`PID ${pid} was already gone (${err instanceof Error ? err.message : String(err)})`);
      removePidFile();
    }
    if (await waitForPidExit(pid)) {
      lines.push(`stopped PID ${pid}`);
      removePidFile();
    } else {
      return { ok: false, error: [...lines, `PID ${pid} did not exit after SIGTERM`, `log: ${logPath()}`].join("\n") };
    }
  } else {
    lines.push("maw messages serve already stopped");
    if (pid && existsSync(pidPath())) {
      removePidFile();
      lines.push("removed stale pid file");
    }
  }

  const unregistered = await waitForRegistration(engineUrl, false);
  if (!unregistered) {
    await unregisterFromEngine(engineUrl);
    lines.push(`forced unregister ${ENGINE_PREFIX}`);
  }
  return { ok: true, output: lines.join("\n") };
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult & Record<string, unknown>> {
  const logs: string[] = [];
  const args = cliArgs(ctx);
  if (args[0] === "serve") return serveEngine(ctx, args.slice(1));
  if (args[0] === "status") return statusEngine(args.slice(1));
  if (args[0] === "stop") return stopEngine(args.slice(1));

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
