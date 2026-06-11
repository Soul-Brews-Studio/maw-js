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
  const resolved = {
    ...defaultDeps(),
    ...deps,
    tmux: {
      ...(defaultDeps().tmux),
      ...(deps.tmux ?? {}),
    },
  };

  const tempDir = resolved.mkdtempSync(join(resolved.tmpdir(), "maw-share-"));
  const consumerPath = makeStreamConsumerPath(tempDir, share.target);

  await Bun.write(consumerPath, "");

  let closed = false;
  let consumerChild: ChildProcessLike | null = null;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;

    try {
      await resolved.tmux.pipePane(share.target);
    } catch {
      // best-effort stream teardown
    }

    await awaitOrKill(consumerChild, resolved);
    consumerChild = null;

    try {
      resolved.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };

  const onMessage = (message: unknown): void => {
    const text = decodeInboundMessage(message);
    if (text !== null && normalizePing(text) === "ping") return;
    // read-only mode intentionally ignores inbound traffic
  };

  try {
    const snapshot = await resolved.tmux.capture(share.target, DEFAULT_SNAPSHOT_LINES);
    if (snapshot) sendSafe(ws, nextEncryptedFrame(share, snapshot));

    const command = `cat >> ${shellEscapeArg(consumerPath)}`;
    await resolved.tmux.pipePane(share.target, command);

    consumerChild = await resolved.spawnTail(consumerPath, (chunk) => {
      if (closed) return;
      sendSafe(ws, nextEncryptedFrame(share, chunk));
    });
  } catch (error) {
    await close();
    throw error;
  }

  return {
    onMessage,
    close,
  };
}
