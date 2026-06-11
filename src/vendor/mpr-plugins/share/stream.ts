import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { Tmux } from "maw-js/sdk";
import type { Share } from "./impl";
import { encryptShareFrame } from "./crypto";

type ChildProcessLike = {
  kill: (signal?: string | number) => void;
  exited: Promise<number | void>;
};

type TmuxShape = Pick<Tmux, "capture" | "pipePane">;

type StreamDeps = {
  tmpdir: typeof tmpdir;
  join: typeof join;
  unlinkSync: typeof unlinkSync;
  tmux: TmuxShape;
  makeFifo: (path: string) => Promise<void>;
  spawnPipeReader: (path: string, onChunk: (chunk: Uint8Array) => void) => Promise<ChildProcessLike>;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

type Subscriber = {
  send: (chunk: string | Uint8Array) => void;
};

type TargetBus = {
  target: string;
  fifoPath: string;
  child: ChildProcessLike | null;
  subscribers: Map<symbol, Subscriber>;
  backlog: Uint8Array[];
  backlogBytes: number;
  closing: Promise<void> | null;
  deps: StreamDeps;
};

const targetBuses = new Map<string, Promise<TargetBus>>();

async function createTargetBus(target: string, deps: StreamDeps): Promise<TargetBus> {
  const fifoPath = makeStreamFifoPath(deps.tmpdir(), target);
  const bus: TargetBus = {
    target,
    fifoPath,
    child: null,
    subscribers: new Map(),
    backlog: [],
    backlogBytes: 0,
    closing: null,
    deps,
  };

  try {
    await deps.makeFifo(fifoPath);
    bus.child = await deps.spawnPipeReader(fifoPath, (chunk) => {
      if (bus.subscribers.size === 0) {
        bufferBacklog(bus, chunk);
        return;
      }
      for (const subscriber of bus.subscribers.values()) subscriber.send(chunk);
    });
    const command = `cat > ${shellEscapeArg(fifoPath)}`;
    // tmux has one pipe-pane slot per pane. Use -o/onlyIfClosed so a second
    // viewer for the same target never clobbers the existing producer; all
    // viewers subscribe to this per-target fan-out bus instead. The FIFO
    // removes the old tmpfile + tail -f relay: tmux writes into the FIFO and
    // our single per-target cat subprocess exposes stdout directly to Bun.
    await deps.tmux.pipePane(target, command, { onlyIfClosed: true });
    return bus;
  } catch (error) {
    targetBuses.delete(target);
    try { await teardownBus(bus); } catch { /* best effort after setup failure */ }
    throw error;
  }
}

async function getTargetBus(target: string, deps: StreamDeps): Promise<TargetBus> {
  let pending = targetBuses.get(target);
  if (!pending) {
    pending = createTargetBus(target, deps);
    targetBuses.set(target, pending);
  }
  return pending;
}

async function teardownBus(bus: TargetBus): Promise<void> {
  if (bus.closing) return bus.closing;
  bus.closing = (async () => {
    targetBuses.delete(bus.target);
    try {
      await bus.deps.tmux.pipePane(bus.target);
    } catch {
      // best-effort stream teardown
    }

    await awaitOrKill(bus.child, bus.deps);
    bus.child = null;

    try {
      bus.deps.unlinkSync(bus.fifoPath);
    } catch {
      // best effort
    }
  })();
  return bus.closing;
}

export function __resetShareStreamBusesForTests(): void {
  targetBuses.clear();
}

export interface ShareStreamHandle {
  onMessage: (message: unknown) => void;
  close: () => Promise<void>;
}

const DEFAULT_SNAPSHOT_LINES = 120;
const CLOSE_TIMEOUT_MS = 50;
const MAX_BACKLOG_CHUNKS = 64;
const MAX_BACKLOG_BYTES = 1024 * 1024;

function defaultDeps(): StreamDeps {
  return {
    tmpdir,
    join,
    unlinkSync,
    tmux: new Tmux(),
    makeFifo: async (path) => {
      const child = Bun.spawn({
        cmd: ["mkfifo", path],
        stdout: "ignore",
        stderr: "pipe",
      });
      const code = await child.exited;
      if (code !== 0) {
        const detail = await new Response(child.stderr).text();
        throw new Error(`share stream failed to create FIFO ${path}: ${detail.trim() || `mkfifo exited ${code}`}`);
      }
    },
    spawnPipeReader: async (path, onChunk) => {
      const child = Bun.spawn({
        cmd: ["cat", path],
        stdout: "pipe",
        stderr: "inherit",
      });
      void (async () => {
        for await (const chunk of child.stdout) {
          if (!chunk || chunk.byteLength === 0) continue;
          onChunk(chunk as Uint8Array);
        }
      })();
      return {
        kill: (signal) => {
          try {
            child.kill(signal);
          } catch {
            // best-effort cleanup
          }
        },
        exited: child.exited.then(() => undefined),
      };
    },
    setTimeout,
    clearTimeout,
  };
}

function shellEscapeArg(value: string): string {
  if (value === "") return "''";
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function decodeInboundMessage(message: unknown): string | null {
  if (typeof message === "string") return message;
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(message));
  if (ArrayBuffer.isView(message)) {
    return new TextDecoder().decode(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
  }
  return null;
}

function makeStreamFifoPath(tmpDir: string, target: string): string {
  const safeTarget = target.replace(/[^a-zA-Z0-9._-]/g, "-");
  const random = Math.random().toString(36).slice(2);
  return join(tmpDir, `maw-share-${process.pid}-${Date.now().toString(36)}-${random}-${safeTarget}.fifo`);
}

function sendSafe(ws: ServerWebSocket, data: string | Uint8Array): void {
  try {
    ws.send(data);
  } catch {
    // ws may be closed already
  }
}

function nextEncryptedFrame(share: Share, data: string | Uint8Array): string | Uint8Array {
  if (!share.encrypted) return data;
  if (!share.encryptionKey) throw new Error("encrypted share is missing its RAM-only key");
  const counter = share.encryptionFrameCounter ?? 0n;
  if (counter >= 0xffff_ffff_ffff_ffffn) {
    throw new Error("encrypted share frame counter exhausted; rotate share key");
  }
  // AES-GCM requires never reusing a (key, nonce) pair. We derive the nonce
  // from this monotonic per-share counter and send it in the frame envelope.
  share.encryptionFrameCounter = counter + 1n;
  return encryptShareFrame(share.encryptionKey, data, counter);
}

function bufferBacklog(bus: TargetBus, chunk: Uint8Array): void {
  const copy = chunk.slice();
  bus.backlog.push(copy);
  bus.backlogBytes += copy.byteLength;

  while (bus.backlog.length > MAX_BACKLOG_CHUNKS || bus.backlogBytes > MAX_BACKLOG_BYTES) {
    const dropped = bus.backlog.shift();
    bus.backlogBytes -= dropped?.byteLength ?? 0;
  }
}

function drainBacklog(bus: TargetBus): Uint8Array[] {
  const backlog = bus.backlog.splice(0);
  bus.backlogBytes = 0;
  return backlog;
}

async function waitForExit(child: ChildProcessLike, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      child.exited.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = globalThis.setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer) globalThis.clearTimeout(timer);
  }
}

async function awaitOrKill(child: ChildProcessLike | null, _deps: Pick<StreamDeps, "setTimeout" | "clearTimeout">): Promise<void> {
  if (!child) return;

  try {
    child.kill("SIGTERM");
  } catch {
    // best effort
  }

  if (await waitForExit(child, CLOSE_TIMEOUT_MS)) return;

  try {
    child.kill("SIGKILL");
  } catch {
    // ignore
  }

  await waitForExit(child, CLOSE_TIMEOUT_MS);
}

function normalizePing(message: string): string {
  return message.trim().toLowerCase();
}

export async function attach(share: Share, ws: ServerWebSocket, deps: Partial<StreamDeps> = {}): Promise<ShareStreamHandle> {
  const baseDeps = defaultDeps();
  const resolved = {
    ...baseDeps,
    ...deps,
    tmux: {
      ...(baseDeps.tmux),
      ...(deps.tmux ?? {}),
    },
  };

  if (share.expiresAt <= Date.now()) {
    throw new Error("share expired before stream attach");
  }

  let closed = false;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let bus: TargetBus | null = null;
  const subscriberId = Symbol(`share:${share.target}`);

  const detach = async (): Promise<void> => {
    if (!bus) return;
    const targetBus = bus;
    bus = null;
    targetBus.subscribers.delete(subscriberId);
    if (targetBus.subscribers.size === 0) await teardownBus(targetBus);
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;

    if (expiryTimer) {
      resolved.clearTimeout(expiryTimer);
      expiryTimer = null;
    }

    await detach();
  };

  expiryTimer = resolved.setTimeout(() => {
    void (async () => {
      const closePromise = close();
      try {
        ws.close(1008, "share expired");
      } catch {
        // socket may already be closed
      }
      await closePromise;
    })();
  }, Math.max(0, share.expiresAt - Date.now()));

  const onMessage = (message: unknown): void => {
    const text = decodeInboundMessage(message);
    if (text !== null && normalizePing(text) === "ping") return;
    // read-only mode intentionally ignores inbound traffic
  };

  try {
    const snapshot = await resolved.tmux.capture(share.target, DEFAULT_SNAPSHOT_LINES);
    if (snapshot) sendSafe(ws, nextEncryptedFrame(share, snapshot));

    bus = await getTargetBus(share.target, resolved);
    if (closed) {
      await detach();
    } else {
      const subscriber = {
        send: (chunk: string | Uint8Array) => {
          if (closed) return;
          sendSafe(ws, nextEncryptedFrame(share, chunk));
        },
      };
      bus.subscribers.set(subscriberId, subscriber);
      for (const chunk of drainBacklog(bus)) subscriber.send(chunk);
    }
  } catch (error) {
    await close();
    throw error;
  }

  return {
    onMessage,
    close,
  };
}
