import { mkdtempSync, rmSync } from "node:fs";
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
  mkdtempSync: typeof mkdtempSync;
  tmpdir: typeof tmpdir;
  join: typeof join;
  rmSync: typeof rmSync;
  tmux: TmuxShape;
  spawnTail: (path: string, onChunk: (chunk: Uint8Array) => void) => Promise<ChildProcessLike>;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

type Subscriber = {
  send: (chunk: string | Uint8Array) => void;
};

type TargetBus = {
  target: string;
  tempDir: string;
  consumerPath: string;
  child: ChildProcessLike | null;
  subscribers: Map<symbol, Subscriber>;
  closing: Promise<void> | null;
  deps: StreamDeps;
};

const targetBuses = new Map<string, Promise<TargetBus>>();

async function createTargetBus(target: string, deps: StreamDeps): Promise<TargetBus> {
  const tempDir = deps.mkdtempSync(join(deps.tmpdir(), "maw-share-"));
  const consumerPath = makeStreamConsumerPath(tempDir, target);
  const bus: TargetBus = {
    target,
    tempDir,
    consumerPath,
    child: null,
    subscribers: new Map(),
    closing: null,
    deps,
  };

  try {
    await Bun.write(consumerPath, "");
    const command = `cat >> ${shellEscapeArg(consumerPath)}`;
    // tmux has one pipe-pane slot per pane. Use -o/onlyIfClosed so a second
    // viewer for the same target never clobbers the existing producer; all
    // viewers subscribe to this per-target fan-out bus instead.
    await deps.tmux.pipePane(target, command, { onlyIfClosed: true });
    bus.child = await deps.spawnTail(consumerPath, (chunk) => {
      for (const subscriber of bus.subscribers.values()) subscriber.send(chunk);
    });
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
      bus.deps.rmSync(bus.tempDir, { recursive: true, force: true });
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
const CLOSE_TIMEOUT_MS = 1_500;

function defaultDeps(): StreamDeps {
  return {
    mkdtempSync,
    tmpdir,
    join,
    rmSync,
    tmux: new Tmux(),
    spawnTail: async (path, onChunk) => {
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

function makeStreamConsumerPath(tmpDir: string, target: string): string {
  return join(tmpDir, `${Date.now().toString(36)}-${target.replace(/[^a-zA-Z0-9._-]/g, "-")}`);
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

async function awaitOrKill(child: ChildProcessLike | null, deps: Pick<StreamDeps, "setTimeout" | "clearTimeout">): Promise<void> {
  if (!child) return;
  const timer = deps.setTimeout(() => {}, CLOSE_TIMEOUT_MS);
  try {
    await Promise.race([
      child.exited,
      new Promise<void>((resolve) => {
        deps.setTimeout(() => {
          resolve();
        }, CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    deps.clearTimeout(timer);
  }

  try {
    child.kill("SIGTERM");
  } catch {
    // best effort
  }

  const hardKill = new Promise<void>((resolve) => {
    deps.setTimeout(() => {
      resolve();
    }, 250);
  });
  try {
    await Promise.race([child.exited, hardKill]);
  } catch {
    // ignore
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // ignore
  }
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
      await close();
      try {
        ws.close(1008, "share expired");
      } catch {
        // socket may already be closed
      }
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
      bus.subscribers.set(subscriberId, {
        send: (chunk) => {
          if (closed) return;
          sendSafe(ws, nextEncryptedFrame(share, chunk));
        },
      });
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
