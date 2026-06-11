import type { ServerWebSocket } from "bun";
import { tmuxLsJsonRows } from "../commands/plugins/tmux/impl";
import { Tmux } from "../core/transport/tmux";
import type { WSData } from "../core/types";

export const TMUX_STREAM_INTERVAL_MS = 200;
export const TMUX_STREAM_CAPTURE_LINES = 200;

type TimerHandle = ReturnType<typeof setInterval>;
type StreamWebSocket = Pick<ServerWebSocket<WSData>, "send">;

type PaneRef = { id?: string };

export interface TmuxStreamDeps {
  intervalMs?: number;
  captureLines?: number;
  layoutRows?: () => Promise<unknown[]>;
  listPanes?: () => Promise<PaneRef[]>;
  capturePane?: (paneId: string, lines: number) => Promise<string>;
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

export function layoutPayload(rows: unknown[]): string {
  return JSON.stringify({ type: "layout", panes: rows });
}

export function capturePayload(captures: Record<string, string>): string {
  return JSON.stringify({ type: "capture", captures });
}

export function createTmuxStreamConnection(ws: StreamWebSocket, deps: TmuxStreamDeps = {}): TmuxStreamConnection {
  const tmux = deps.listPanes && deps.capturePane ? null : new Tmux();
  const intervalMs = deps.intervalMs ?? TMUX_STREAM_INTERVAL_MS;
  const captureLines = deps.captureLines ?? TMUX_STREAM_CAPTURE_LINES;
  const layoutRows = deps.layoutRows ?? (() => tmuxLsJsonRows({ all: true, compact: true, teams: true, channels: true }));
  const listPanes = deps.listPanes ?? (() => tmux!.listPanes());
  const capturePane = deps.capturePane ?? ((paneId: string, lines: number) => tmux!.capture(paneId, lines));
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const captures: Record<string, string> = {};
  let captureRunning = false;
  let closed = false;
  let layoutTimer: TimerHandle | undefined;
  let captureTimer: TimerHandle | undefined;

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
      if (opts.force || changed) safeSend(ws, capturePayload(captures));
    } catch (error) {
      logStreamError(deps, "capture refresh failed", error);
    } finally {
      captureRunning = false;
    }
  }

  function close(): void {
    closed = true;
    if (layoutTimer) clearIntervalFn(layoutTimer);
    if (captureTimer) clearIntervalFn(captureTimer);
  }

  if (deps.startTimers !== false) {
    void sendLayout();
    void sendCapture({ force: true });
    layoutTimer = setIntervalFn(() => { void sendLayout(); }, intervalMs);
    captureTimer = setIntervalFn(() => { void sendCapture(); }, intervalMs);
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
