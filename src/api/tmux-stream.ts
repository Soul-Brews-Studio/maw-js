import type { ServerWebSocket } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmuxLsJsonRows } from "../commands/plugins/tmux/impl";
import { Tmux } from "../core/transport/tmux";
import type { WSData } from "../core/types";

export const TMUX_STREAM_INTERVAL_MS = 200;
export const TMUX_STREAM_CAPTURE_LINES = 200;

type TimerHandle = ReturnType<typeof setInterval>;
type StreamWebSocket = Pick<ServerWebSocket<WSData>, "send">;

type PaneRef = { id?: string };
type ChildProcessLike = {
  kill: (signal?: string | number) => void;
  exited: Promise<unknown>;
};
type PipePaneFn = (paneId: string, command?: string, opts?: { onlyIfClosed?: boolean }) => Promise<void>;
type PipeSubscriber = (chunk: Uint8Array) => void;
type PanePipeEntry = {
  paneId: string;
  dir: string;
  file: string;
  child: ChildProcessLike | null;
  refs: number;
  subscribers: Set<PipeSubscriber>;
};

const panePipeRegistry = new Map<string, PanePipeEntry>();

export interface TmuxStreamDeps {
  intervalMs?: number;
  captureLines?: number;
  layoutRows?: () => Promise<unknown[]>;
  listPanes?: () => Promise<PaneRef[]>;
  capturePane?: (paneId: string, lines: number) => Promise<string>;
  pipePane?: PipePaneFn;
  spawnTail?: (path: string, onChunk: (chunk: Uint8Array) => void) => Promise<ChildProcessLike>;
  mkdtempSync?: typeof mkdtempSync;
  tmpdir?: typeof tmpdir;
  join?: typeof join;
  rmSync?: typeof rmSync;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  startTimers?: boolean;
  onError?: (message: string, error: unknown) => void;
}

export interface TmuxStreamConnection {
  sendLayout: () => Promise<void>;
  sendCapture: (opts?: { force?: boolean }) => Promise<void>;
  close: () => void;
}

function safeSend(ws: StreamWebSocket, payload: string): void {
  try { ws.send(payload); } catch { /* client may close between ticks */ }
}

function logStreamError(deps: TmuxStreamDeps, message: string, error: unknown): void {
  if (deps.onError) deps.onError(message, error);
  else console.warn(`[tmux-stream] ${message}: ${error instanceof Error ? error.message : String(error)}`);
}

function shellEscapeArg(value: string): string {
  if (value === "") return "''";
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function defaultSpawnTail(path: string, onChunk: (chunk: Uint8Array) => void): Promise<ChildProcessLike> {
  const child = Bun.spawn({
    cmd: ["tail", "-n", "0", "-f", path],
    stdout: "pipe",
    stderr: "inherit",
  });
  void (async () => {
    for await (const chunk of child.stdout) {
      if (!chunk || chunk.byteLength === 0) continue;
      onChunk(chunk as Uint8Array);
    }
  })();
  return Promise.resolve({
    kill: (signal) => {
      try { child.kill(signal); } catch { /* best-effort cleanup */ }
    },
    exited: child.exited,
  });
}

async function acquirePanePipe(
  paneId: string,
  subscriber: PipeSubscriber,
  deps: {
    pipePane: PipePaneFn;
    spawnTail: (path: string, onChunk: (chunk: Uint8Array) => void) => Promise<ChildProcessLike>;
    mkTempDir: typeof mkdtempSync;
    getTmpdir: typeof tmpdir;
    joinPath: typeof join;
    removeDir: typeof rmSync;
  },
): Promise<void> {
  const existing = panePipeRegistry.get(paneId);
  if (existing) {
    existing.refs += 1;
    existing.subscribers.add(subscriber);
    return;
  }

  const dir = deps.mkTempDir(deps.joinPath(deps.getTmpdir(), "maw-tmux-stream-"));
  const file = deps.joinPath(dir, `${paneId.replace(/[^a-zA-Z0-9._-]/g, "-")}.log`);
  await Bun.write(file, "");
  const entry: PanePipeEntry = {
    paneId,
    dir,
    file,
    child: null,
    refs: 1,
    subscribers: new Set([subscriber]),
  };
  panePipeRegistry.set(paneId, entry);

  try {
    entry.child = await deps.spawnTail(file, (chunk) => {
      for (const send of [...entry.subscribers]) send(chunk);
    });
    void entry.child.exited.catch(() => {});
    await deps.pipePane(paneId, `cat >> ${shellEscapeArg(file)}`, { onlyIfClosed: true });
  } catch (error) {
    panePipeRegistry.delete(paneId);
    try { entry.child?.kill("SIGTERM"); } catch { /* best-effort tail cleanup */ }
    try { deps.removeDir(dir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
    throw error;
  }
}

async function releasePanePipe(
  paneId: string,
  subscriber: PipeSubscriber,
  deps: {
    pipePane: PipePaneFn;
    removeDir: typeof rmSync;
  },
): Promise<void> {
  const entry = panePipeRegistry.get(paneId);
  if (!entry) return;
  if (entry.subscribers.delete(subscriber)) entry.refs -= 1;
  if (entry.refs > 0) return;

  panePipeRegistry.delete(paneId);
  try { await deps.pipePane(paneId); } catch { /* pane may already be gone */ }
  try { entry.child?.kill("SIGTERM"); } catch { /* best-effort tail cleanup */ }
  try { deps.removeDir(entry.dir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
}

export function layoutPayload(rows: unknown[]): string {
  return JSON.stringify({ type: "layout", panes: rows });
}

export function capturePayload(captures: Record<string, string>): string {
  return JSON.stringify({ type: "capture", captures });
}

export function createTmuxStreamConnection(ws: StreamWebSocket, deps: TmuxStreamDeps = {}): TmuxStreamConnection {
  const tmux = deps.listPanes && deps.capturePane && deps.pipePane ? null : new Tmux();
  const intervalMs = deps.intervalMs ?? TMUX_STREAM_INTERVAL_MS;
  const captureLines = deps.captureLines ?? TMUX_STREAM_CAPTURE_LINES;
  const layoutRows = deps.layoutRows ?? (() => tmuxLsJsonRows({ all: true, compact: true, teams: true, channels: true }));
  const listPanes = deps.listPanes ?? (() => tmux!.listPanes());
  const capturePane = deps.capturePane ?? ((paneId: string, lines: number) => tmux!.capture(paneId, lines));
  const pipePane = deps.pipePane ?? ((paneId: string, command?: string, opts?: { onlyIfClosed?: boolean }) => tmux!.pipePane(paneId, command, opts));
  const spawnTail = deps.spawnTail ?? defaultSpawnTail;
  const mkTempDir = deps.mkdtempSync ?? mkdtempSync;
  const getTmpdir = deps.tmpdir ?? tmpdir;
  const joinPath = deps.join ?? join;
  const removeDir = deps.rmSync ?? rmSync;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const captures: Record<string, string> = {};
  const acquiredPipes = new Map<string, PipeSubscriber>();
  const decoder = new TextDecoder();
  let captureRunning = false;
  let closed = false;
  let layoutTimer: TimerHandle | undefined;

  async function sendLayout(): Promise<void> {
    if (closed) return;
    try {
      safeSend(ws, layoutPayload(await layoutRows()));
    } catch (error) {
      logStreamError(deps, "layout refresh failed", error);
    }
  }

  async function sendCapture(opts: { force?: boolean } = {}): Promise<void> {
    if (closed || captureRunning) return;
    captureRunning = true;
    try {
      const panes = (await listPanes()).filter((pane): pane is { id: string } => typeof pane.id === "string" && pane.id.length > 0);
      const liveIds = new Set(panes.map(pane => pane.id));
      let changed = false;
      const entries = await Promise.all(panes.map(async pane => {
        try {
          return [pane.id, await capturePane(pane.id, captureLines)] as const;
        } catch (error) {
          logStreamError(deps, `capture failed for pane ${pane.id}`, error);
          return [pane.id, captures[pane.id] ?? ""] as const;
        }
      }));
      for (const [id, text] of entries) {
        if (captures[id] !== text) {
          captures[id] = text;
          changed = true;
        }
      }
      for (const id of Object.keys(captures)) {
        if (!liveIds.has(id)) {
          delete captures[id];
          changed = true;
        }
      }
      await syncPanePipes(liveIds);
      if (opts.force || changed) safeSend(ws, capturePayload(captures));
    } catch (error) {
      logStreamError(deps, "capture refresh failed", error);
    } finally {
      captureRunning = false;
    }
  }

  function appendPipeChunk(paneId: string, chunk: Uint8Array): void {
    if (closed) return;
    const text = decoder.decode(chunk, { stream: true });
    if (!text) return;
    captures[paneId] = (captures[paneId] ?? "") + text;
    safeSend(ws, capturePayload(captures));
  }

  async function startPanePipe(paneId: string): Promise<void> {
    if (closed || acquiredPipes.has(paneId)) return;
    const subscriber = (chunk: Uint8Array) => appendPipeChunk(paneId, chunk);
    try {
      await acquirePanePipe(paneId, subscriber, { pipePane, spawnTail, mkTempDir, getTmpdir, joinPath, removeDir });
      acquiredPipes.set(paneId, subscriber);
    } catch (error) {
      logStreamError(deps, `pipe setup failed for pane ${paneId}`, error);
    }
  }

  async function stopPanePipe(paneId: string): Promise<void> {
    const subscriber = acquiredPipes.get(paneId);
    if (!subscriber) return;
    acquiredPipes.delete(paneId);
    await releasePanePipe(paneId, subscriber, { pipePane, removeDir });
  }

  async function syncPanePipes(liveIds: Set<string>): Promise<void> {
    await Promise.all([...acquiredPipes.keys()].filter((id) => !liveIds.has(id)).map((id) => stopPanePipe(id)));
    await Promise.all([...liveIds].filter((id) => !acquiredPipes.has(id)).map((id) => startPanePipe(id)));
  }

  function close(): void {
    closed = true;
    if (layoutTimer) clearIntervalFn(layoutTimer);
    void Promise.all([...acquiredPipes.keys()].map((id) => stopPanePipe(id)));
  }

  if (deps.startTimers !== false) {
    void sendLayout();
    void sendCapture({ force: true });
    layoutTimer = setIntervalFn(() => { void sendLayout(); }, intervalMs);
  }

  return { sendLayout, sendCapture, close };
}

const connections = new WeakMap<ServerWebSocket<WSData>, TmuxStreamConnection>();

export function handleTmuxStreamOpen(ws: ServerWebSocket<WSData>): void {
  connections.set(ws, createTmuxStreamConnection(ws));
}

export function handleTmuxStreamMessage(ws: ServerWebSocket<WSData>, msg: unknown): void {
  const connection = connections.get(ws);
  if (!connection) return;
  if (msg === "refresh") {
    void connection.sendLayout();
    void connection.sendCapture({ force: true });
  }
}

export function handleTmuxStreamClose(ws: ServerWebSocket<WSData>): void {
  connections.get(ws)?.close();
  connections.delete(ws);
}
