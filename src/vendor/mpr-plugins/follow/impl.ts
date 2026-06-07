import { loadConfig } from "maw-js/config";
import { listSessions } from "maw-js/sdk";
import { loadFleet } from "maw-js/commands/shared/fleet-load";
import { resolveAttachTarget } from "../attach/resolve-attach-target";

export const FOLLOW_USAGE = "usage: maw follow <pane> [--since=<dur>] [--json] [--grep <pattern>] [--quit-on-idle=<dur>]";

type FollowReason = "detached" | "closed" | "idle" | "signal" | "error";

export interface FollowOptions {
  since?: string;
  json?: boolean;
  grep?: string;
  quitOnIdle?: string;
}

export interface FollowResult {
  pane: string;
  reason: FollowReason;
  chunks: number;
}

type WebSocketLike = {
  readyState: number;
  binaryType?: BinaryType;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

type WebSocketCtor = new (url: string) => WebSocketLike;

export interface FollowDeps {
  WebSocketCtor: WebSocketCtor;
  loadConfig: typeof loadConfig;
  listSessions: typeof listSessions;
  loadFleet: typeof loadFleet;
  stdoutWrite: (chunk: string) => void;
  stderrWrite: (chunk: string) => void;
  now: () => number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  processOn: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void;
  processOff: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void;
}

export function followDeps(overrides: Partial<FollowDeps> = {}): FollowDeps {
  return {
    WebSocketCtor: WebSocket as unknown as WebSocketCtor,
    loadConfig,
    listSessions,
    loadFleet,
    stdoutWrite: (chunk) => { process.stdout.write(chunk); },
    stderrWrite: (chunk) => { process.stderr.write(chunk); },
    now: Date.now,
    setTimeout,
    clearTimeout,
    processOn: (signal, handler) => { process.on(signal, handler); },
    processOff: (signal, handler) => { process.off(signal, handler); },
    ...overrides,
  };
}

export function parseDurationMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const input = raw.trim();
  if (!input) return null;
  if (/^\d+(?:\.\d+)?$/.test(input)) return Math.round(Number(input) * 1000);

  const unitMs: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let total = 0;
  let pos = 0;
  for (let m = re.exec(input); m; m = re.exec(input)) {
    if (m.index !== pos) return null;
    total += Number(m[1]) * unitMs[m[2] as keyof typeof unitMs];
    pos = m.index + m[0].length;
  }
  return pos === input.length ? Math.round(total) : null;
}

export function replayLinesForDuration(ms: number): number {
  return Math.max(1, Math.min(10_000, Math.ceil(ms / 1000)));
}

export function followUrlFromConfig(deps: Pick<FollowDeps, "loadConfig"> = followDeps()): string {
  const explicit = process.env.MAW_ENGINE_URL?.trim();
  if (explicit) {
    const url = new URL(explicit);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws/pty";
    url.search = "";
    url.hash = "";
    return url.toString();
  }
  const port = process.env.MAW_PORT || deps.loadConfig().port || 3456;
  return `ws://127.0.0.1:${port}/ws/pty`;
}

export async function resolveFollowTarget(target: string, deps: Pick<FollowDeps, "listSessions" | "loadFleet">): Promise<string> {
  const raw = target.trim();
  if (!raw || raw.startsWith("-")) throw new Error(FOLLOW_USAGE);

  const numericTmuxTarget = /^(.*):(\d+(?:\.\d+)?)$/.exec(raw);
  if (!raw.includes(":") || numericTmuxTarget) {
    const sessionQuery = numericTmuxTarget ? numericTmuxTarget[1] : raw;
    const result = await resolveAttachTarget(sessionQuery, {
      listSessions: deps.listSessions as any,
      loadFleet: deps.loadFleet as any,
    });
    if (!result) throw new Error(`follow: session '${sessionQuery}' not found`);
    if (result.tier !== 1) throw new Error(`follow: session '${sessionQuery}' is not running`);
    if (result.ambiguousCandidates && result.ambiguousCandidates.length > 1) {
      throw new Error(`follow: '${sessionQuery}' is ambiguous: ${result.ambiguousCandidates.join(", ")}`);
    }
    const resolved = result.windowName ? `${result.sessionName}:${result.windowName}` : result.sessionName;
    if (!numericTmuxTarget) return resolved;
    const paneSuffix = numericTmuxTarget[2];
    return result.windowName && !paneSuffix.includes(".")
      ? `${resolved}.${paneSuffix}`
      : `${result.sessionName}:${paneSuffix}`;
  }

  return raw;
}

async function frameToText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) return await data.text();
  return String(data ?? "");
}

function parseControlFrame(text: string): { type?: string; target?: string; message?: string } | null {
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && typeof parsed.type === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function compileGrep(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch (e: any) {
    throw new Error(`follow: invalid --grep pattern: ${e.message || e}`);
  }
}

function eventTimestamp(deps: Pick<FollowDeps, "now">): string {
  return new Date(deps.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function cmdFollow(target: string, opts: FollowOptions = {}, overrides: Partial<FollowDeps> = {}): Promise<FollowResult> {
  const deps = followDeps(overrides);
  const pane = await resolveFollowTarget(target, deps);
  const sinceMs = opts.since ? parseDurationMs(opts.since) : null;
  if (opts.since && sinceMs === null) throw new Error(`follow: invalid --since duration: ${opts.since}`);
  const idleMs = opts.quitOnIdle ? parseDurationMs(opts.quitOnIdle) : null;
  if (opts.quitOnIdle && (!idleMs || idleMs <= 0)) throw new Error(`follow: invalid --quit-on-idle duration: ${opts.quitOnIdle}`);

  const replayLines = sinceMs === null ? 0 : replayLinesForDuration(sinceMs);
  const grep = compileGrep(opts.grep);
  const url = followUrlFromConfig(deps);
  const ws = new deps.WebSocketCtor(url);
  ws.binaryType = "arraybuffer";

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let chunks = 0;

  return await new Promise<FollowResult>((resolve, reject) => {
    const clearIdle = () => {
      if (idleTimer) deps.clearTimeout(idleTimer);
      idleTimer = null;
    };
    const sendDetach = () => {
      try { ws.send(JSON.stringify({ type: "detach" })); } catch { /* expected: socket may already be closed */ }
    };
    const closeSocket = () => {
      try { ws.close(); } catch { /* expected: socket may already be closed */ }
    };
    const cleanup = () => {
      clearIdle();
      deps.processOff("SIGINT", onSignal);
      deps.processOff("SIGTERM", onSignal);
    };
    const finish = (reason: FollowReason, err?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve({ pane, reason, chunks });
    };
    const armIdle = () => {
      if (!idleMs) return;
      clearIdle();
      idleTimer = deps.setTimeout(() => {
        sendDetach();
        finish("idle");
        closeSocket();
      }, idleMs);
    };
    const onSignal = () => {
      sendDetach();
      finish("signal");
      closeSocket();
    };
    const emitChunk = (chunk: string) => {
      if (!chunk) return;
      if (grep) {
        grep.lastIndex = 0;
        if (!grep.test(chunk)) return;
      }
      chunks += 1;
      if (opts.json) {
        deps.stdoutWrite(JSON.stringify({ ts: eventTimestamp(deps), pane, chunk }) + "\n");
      } else {
        deps.stdoutWrite(chunk);
      }
      armIdle();
    };

    deps.processOn("SIGINT", onSignal);
    deps.processOn("SIGTERM", onSignal);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "attach", target: pane, cols: 120, rows: 40, replayLines }));
      armIdle();
    };
    ws.onmessage = (event) => {
      void (async () => {
        const text = await frameToText(event.data);
        const control = parseControlFrame(text);
        if (control?.type === "attached") return;
        if (control?.type === "detached") {
          finish("detached");
          return;
        }
        if (control?.type === "error") {
          const message = control.message || "PTY follow error";
          deps.stderrWrite(`follow: ${message}\n`);
          finish("error", new Error(message));
          return;
        }
        emitChunk(text);
      })().catch((e: any) => finish("error", e instanceof Error ? e : new Error(String(e))));
    };
    ws.onerror = () => {
      finish("error", new Error(`follow: websocket error: ${url}`));
    };
    ws.onclose = () => {
      finish("closed");
    };
  });
}
