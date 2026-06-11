import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const original = {
  cwd: process.cwd(),
  home: process.env.HOME,
  mawHome: process.env.MAW_HOME,
  pluginsDir: process.env.MAW_PLUGINS_DIR,
  hotReload: process.env.MAW_HOT_RELOAD,
  gateway: process.env.MAW_GATEWAY,
  verbosity: process.env.MAW_SERVE_VERBOSITY,
  cli: process.env.MAW_CLI,
};

let root = "";

type BunServerLike = { port: number; stop: (force?: boolean) => void };

function restoreEnv(key: keyof typeof original, envName: keyof NodeJS.ProcessEnv): void {
  const value = original[key];
  if (value === undefined) delete process.env[envName];
  else process.env[envName] = value;
}

function waitForOpen(ws: WebSocket, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      try { ws.close(); } catch { /* best effort */ }
      reject(new Error(`websocket did not open within ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("websocket errored before open")); };
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
  });
}

function waitForJsonFrame(ws: WebSocket, predicate: (value: any) => boolean, timeoutMs = 5_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`websocket frame did not arrive within ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    const onMessage = (event: MessageEvent) => {
      const text = typeof event.data === "string" ? event.data : String(event.data);
      let parsed: any;
      try { parsed = JSON.parse(text); } catch { return; }
      if (!predicate(parsed)) return;
      cleanup();
      resolve(parsed);
    };
    const onError = () => { cleanup(); reject(new Error("websocket errored while waiting for frame")); };
    const onClose = () => { cleanup(); reject(new Error("websocket closed before expected frame")); };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError, { once: true });
    ws.addEventListener("close", onClose, { once: true });
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "maw-real-serve-smoke-"));
  mkdirSync(join(root, "home"), { recursive: true });
  mkdirSync(join(root, "plugins"), { recursive: true });
  mkdirSync(join(root, "cwd"), { recursive: true });
  process.chdir(join(root, "cwd"));

  process.env.HOME = join(root, "home");
  process.env.MAW_HOME = join(root, "home", ".maw");
  process.env.MAW_PLUGINS_DIR = join(root, "plugins");
  process.env.MAW_HOT_RELOAD = "0";
  process.env.MAW_GATEWAY = "bun";
  process.env.MAW_SERVE_VERBOSITY = "0";
  process.env.MAW_CLI = "1";
});

afterEach(() => {
  process.chdir(original.cwd);
  restoreEnv("home", "HOME");
  restoreEnv("mawHome", "MAW_HOME");
  restoreEnv("pluginsDir", "MAW_PLUGINS_DIR");
  restoreEnv("hotReload", "MAW_HOT_RELOAD");
  restoreEnv("gateway", "MAW_GATEWAY");
  restoreEnv("verbosity", "MAW_SERVE_VERBOSITY");
  restoreEnv("cli", "MAW_CLI");
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("startServer real Bun.serve smoke (#2749)", () => {
  test("serves real HTTP and upgrades a real WebSocket route", async () => {
    const { startServer } = await import("../../src/core/server.ts?real-bunserve-smoke");
    let server: BunServerLike | undefined;
    let ws: WebSocket | undefined;

    try {
      server = await startServer(0, {
        transports: [],
        intervals: false,
        views: false,
        apiRouters: [],
      }, { verbosity: 0, gateway: "bun" }) as BunServerLike;

      expect(server.port).toBeGreaterThan(0);
      const origin = `http://127.0.0.1:${server.port}`;

      const http = await fetch(`${origin}/api/feed?limit=1`);
      expect(http.status).toBe(200);
      await expect(http.json()).resolves.toMatchObject({ events: expect.any(Array) });

      ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      await waitForOpen(ws);
      const frame = await waitForJsonFrame(ws, (value) => value?.type === "feed-history");
      expect(frame).toMatchObject({ type: "feed-history", events: expect.any(Array) });
    } finally {
      if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
      server?.stop(true);
    }
  }, 10_000);
});
