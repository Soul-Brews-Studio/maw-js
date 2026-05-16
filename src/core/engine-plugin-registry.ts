import { NAME_RE } from "../plugin/manifest-constants";
import type { FeedEvent } from "../lib/feed";
import { homedir, tmpdir } from "os";
import { resolve, sep } from "path";

export interface EnginePluginRegistrationInput {
  plugin: string;
  prefix: string;
  upstream: string;
  events?: string[];
  eventPath?: string;
  health?: string;
}

export interface EnginePluginRegistration extends EnginePluginRegistrationInput {
  prefix: string;
  upstream: string;
  registeredAt: string;
}

const registrations = new Map<string, EnginePluginRegistration>();

type EngineFetchTarget = { url: URL; unix?: string };
type BunUnixRequestInit = RequestInit & { unix?: string };

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed.startsWith("/api/")) {
    throw new Error("engine prefix must start with /api/");
  }
  if (trimmed === "/api/" || trimmed.length <= "/api/".length) {
    throw new Error("engine prefix must include a plugin path after /api/");
  }
  if (trimmed.startsWith("/api/_engine")) {
    throw new Error("engine prefix may not bind /api/_engine");
  }
  if (/\s/.test(trimmed) || trimmed.includes("//") || trimmed.includes("..")) {
    throw new Error("engine prefix must be a clean absolute /api path");
  }
  return trimmed.replace(/\/+$/, "");
}

function normalizeUpstream(upstream: string): string {
  const raw = upstream.trim();
  if (raw.startsWith("unix:") && /(?:\.\.|%2e)/i.test(raw)) {
    throw new Error("engine unix upstream path must not contain traversal");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("engine upstream must be a URL");
  }
  if (url.protocol === "unix:") {
    return normalizeUnixUpstream(url);
  }
  if (url.protocol !== "http:") {
    throw new Error("engine upstream must be loopback http:// or local unix://");
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") {
    throw new Error("engine upstream must be loopback only");
  }
  url.hash = "";
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function normalizeUnixUpstream(url: URL): string {
  if (url.hostname || url.search || url.hash) {
    throw new Error("engine unix upstream must be unix:///absolute/path.sock with no host, query, or hash");
  }
  const socketPath = decodeURIComponent(url.pathname);
  return `unix://${normalizeUnixSocketPath(socketPath)}`;
}

function activeMawHome(): string {
  return process.env.MAW_HOME || `${homedir()}/.maw`;
}

function isInside(path: string, root: string): boolean {
  const normalizedRoot = resolve(root);
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}${sep}`);
}

function normalizeUnixSocketPath(socketPath: string): string {
  if (!socketPath.startsWith("/")) {
    throw new Error("engine unix upstream must use an absolute socket path");
  }
  if (socketPath.includes("\0") || /\s/.test(socketPath)) {
    throw new Error("engine unix upstream path must not contain null bytes or whitespace");
  }
  if (!socketPath.endsWith(".sock")) {
    throw new Error("engine unix upstream path must end with .sock");
  }
  const normalized = resolve(socketPath);
  if (normalized !== socketPath) {
    throw new Error("engine unix upstream path must not contain traversal");
  }

  // Do not let a dynamic engine registration turn maw into a reverse proxy for
  // privileged local sockets such as /var/run/docker.sock. Plugin sockets must
  // live in operator-owned temp space or MAW_HOME.
  const allowedRoots = [
    tmpdir(),
    "/tmp",
    "/private/tmp",
    activeMawHome(),
  ].map((root) => resolve(root));
  if (!allowedRoots.some((root) => isInside(normalized, root))) {
    throw new Error("engine unix upstream path must live under tmpdir or MAW_HOME");
  }
  return normalized;
}

function normalizeStringArray(value: string[] | undefined, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
    throw new Error(`engine ${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((v) => v.trim()))];
}

function normalizeHealth(health: string | undefined): string | undefined {
  return normalizeCleanPath(health, "health");
}

function normalizeEventPath(eventPath: string | undefined): string | undefined {
  return normalizeCleanPath(eventPath, "eventPath");
}

function normalizeCleanPath(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.includes("..") || trimmed.includes("//") || /\s/.test(trimmed)) {
    throw new Error(`engine ${field} must be a clean absolute path`);
  }
  return trimmed;
}

export function clearEnginePluginRegistrations(): void {
  registrations.clear();
}

export function registerEnginePlugin(input: EnginePluginRegistrationInput): EnginePluginRegistration {
  if (!NAME_RE.test(input.plugin)) {
    throw new Error("engine plugin must match /^[a-z0-9-]+$/");
  }
  const prefix = normalizePrefix(input.prefix);
  const upstream = normalizeUpstream(input.upstream);
  const events = normalizeStringArray(input.events, "events");
  const eventPath = normalizeEventPath(input.eventPath);
  const health = normalizeHealth(input.health);

  // One live dynamic surface per plugin in this alpha slice. A plugin can
  // re-register after restart and atomically replace its old binding.
  for (const [existingPrefix, existing] of registrations) {
    if (existing.plugin === input.plugin) registrations.delete(existingPrefix);
  }

  const registration: EnginePluginRegistration = {
    plugin: input.plugin,
    prefix,
    upstream,
    registeredAt: new Date().toISOString(),
    ...(events ? { events } : {}),
    ...(eventPath ? { eventPath } : {}),
    ...(health ? { health } : {}),
  };
  registrations.set(prefix, registration);
  return registration;
}

export function unregisterEnginePlugin(input: { plugin?: string; prefix?: string }): boolean {
  let removed = false;
  if (input.prefix) {
    const prefix = normalizePrefix(input.prefix);
    removed = registrations.delete(prefix) || removed;
  }
  if (input.plugin) {
    if (!NAME_RE.test(input.plugin)) {
      throw new Error("engine plugin must match /^[a-z0-9-]+$/");
    }
    for (const [prefix, registration] of registrations) {
      if (registration.plugin === input.plugin) {
        registrations.delete(prefix);
        removed = true;
      }
    }
  }
  return removed;
}

export function listEnginePluginRegistrations(): EnginePluginRegistration[] {
  return [...registrations.values()].sort((a, b) => a.prefix.localeCompare(b.prefix));
}

export function findEnginePluginRegistration(pathname: string): EnginePluginRegistration | undefined {
  if (!pathname.startsWith("/api/") || pathname.startsWith("/api/_engine")) return undefined;
  const candidates = [...registrations.values()]
    .filter((registration) => pathname === registration.prefix || pathname.startsWith(`${registration.prefix}/`))
    .sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix));
  return candidates[0];
}

function isUnixUpstream(upstream: string): boolean {
  return upstream.startsWith("unix://");
}

function unixSocketPath(upstream: string): string {
  return upstream.slice("unix://".length);
}

function targetForRequest(req: Request, registration: EnginePluginRegistration): EngineFetchTarget {
  if (isUnixUpstream(registration.upstream)) {
    const incoming = new URL(req.url);
    const suffix = incoming.pathname.slice(registration.prefix.length);
    const target = new URL(`http://localhost${suffix || "/"}`);
    target.search = incoming.search;
    return { url: target, unix: unixSocketPath(registration.upstream) };
  }
  return { url: targetUrlForHttp(req, registration) };
}

function targetUrlForHttp(req: Request, registration: EnginePluginRegistration): URL {
  const incoming = new URL(req.url);
  const base = new URL(registration.upstream);
  const suffix = incoming.pathname.slice(registration.prefix.length);
  const basePath = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "");
  base.pathname = `${basePath}${suffix || "/"}`;
  base.search = incoming.search;
  return base;
}

function targetForHealth(registration: EnginePluginRegistration): EngineFetchTarget | undefined {
  if (!registration.health) return undefined;
  return targetForPath(registration, registration.health);
}

function targetForEvent(registration: EnginePluginRegistration): EngineFetchTarget {
  return targetForPath(registration, registration.eventPath ?? "/events")!;
}

function targetForPath(registration: EnginePluginRegistration, path: string): EngineFetchTarget | undefined {
  if (isUnixUpstream(registration.upstream)) {
    return { url: new URL(`http://localhost${path}`), unix: unixSocketPath(registration.upstream) };
  }
  const base = new URL(registration.upstream);
  const basePath = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "");
  base.pathname = `${basePath}${path}`;
  base.search = "";
  return { url: base };
}

function engineFetch(target: EngineFetchTarget, init: RequestInit): Promise<Response> {
  const opts: BunUnixRequestInit = target.unix ? { ...init, unix: target.unix } : init;
  return fetch(target.url, opts);
}

export async function checkEnginePluginHealth(registration: EnginePluginRegistration): Promise<boolean> {
  const target = targetForHealth(registration);
  if (!target) return true;
  try {
    const response = await engineFetch(target, {
      method: "GET",
      headers: {
        "x-maw-engine-plugin": registration.plugin,
        "x-forwarded-prefix": registration.prefix,
      },
      signal: AbortSignal.timeout(1_000),
    });
    if (response.ok) return true;
    throw new Error(`health returned ${response.status}`);
  } catch (err) {
    registrations.delete(registration.prefix);
    console.warn(`[engine-plugin] unbound ${registration.plugin} at ${registration.prefix}: health check failed (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}

export async function pollEnginePluginHealth(): Promise<{ checked: number; removed: number }> {
  const current = listEnginePluginRegistrations().filter((registration) => !!registration.health);
  let removed = 0;
  for (const registration of current) {
    const ok = await checkEnginePluginHealth(registration);
    if (!ok) removed++;
  }
  return { checked: current.length, removed };
}

export function startEnginePluginHealthPolling(intervalMs = 5_000): () => void {
  const timer = setInterval(() => {
    pollEnginePluginHealth().catch((err) => {
      console.warn(`[engine-plugin] health poll failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function dispatchEnginePluginEvent(event: FeedEvent): Promise<{ delivered: number; failed: number; removed: number }> {
  const current = listEnginePluginRegistrations().filter((registration) =>
    registration.events?.includes(event.event),
  );
  let delivered = 0;
  let failed = 0;
  let removed = 0;

  for (const registration of current) {
    const target = targetForEvent(registration);
    try {
      const response = await engineFetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-maw-engine-plugin": registration.plugin,
          "x-forwarded-prefix": registration.prefix,
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        delivered++;
      } else {
        failed++;
        console.warn(`[engine-plugin] event delivery to ${registration.plugin} returned ${response.status} for ${event.event}`);
      }
    } catch (err) {
      failed++;
      removed++;
      registrations.delete(registration.prefix);
      console.warn(`[engine-plugin] unbound ${registration.plugin} at ${registration.prefix}: event delivery failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  return { delivered, failed, removed };
}

export async function proxyEnginePluginRequest(req: Request, registration: EnginePluginRegistration): Promise<Response> {
  const target = targetForRequest(req, registration);
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.set("x-maw-engine-plugin", registration.plugin);
  headers.set("x-forwarded-prefix", registration.prefix);

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  try {
    const upstream = await engineFetch(target, init);
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("x-maw-engine-plugin", registration.plugin);
    responseHeaders.set("x-forwarded-prefix", registration.prefix);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    registrations.delete(registration.prefix);
    console.warn(`[engine-plugin] unbound ${registration.plugin} at ${registration.prefix}: ${err instanceof Error ? err.message : String(err)}`);
    return Response.json(
      { ok: false, error: "engine_plugin_unavailable", plugin: registration.plugin, prefix: registration.prefix },
      { status: 503 },
    );
  }
}
