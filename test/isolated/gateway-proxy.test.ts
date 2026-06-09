/**
 * Rust gateway reverse-proxy integration contract (#2644).
 *
 * This spec intentionally targets the Phase 3 contract from #2642/#2643:
 *   maw-gateway serve --port <gateway> --backend <bun-backend>
 *
 * It is opt-in until the reverse proxy implementation lands. Enable with:
 *   MAW_RUN_GATEWAY_PROXY_INTEGRATION=1 bun test test/isolated/gateway-proxy.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";

const RUN = process.env.MAW_RUN_GATEWAY_PROXY_INTEGRATION === "1";
const ROOT = join(import.meta.dir, "../..");
const GATEWAY_DIR = join(ROOT, "packages/maw-gateway");
const GATEWAY_BIN = join(GATEWAY_DIR, "target/release/maw-gateway");
const TEST_TIMEOUT_MS = 10_000;

const children: ChildProcessWithoutNullStreams[] = [];
const bunServers: Array<{ stop(force?: boolean): void }> = [];

type GatewayProcess = {
  child: ChildProcessWithoutNullStreams;
  gatewayPort: number;
  backendPort: number;
};

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to reserve test port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = TEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHttp(url: string, timeoutMs = TEST_TIMEOUT_MS): Promise<Response> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetchWithTimeout(url, {}, 1_000);
      if (response.status < 500) return response;
      lastError = new Error(`status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}: ${String(lastError)}`);
}

function startBunBackend() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/api/ui-state") {
        return Response.json({ source: "bun", ok: true, route: "/api/ui-state" });
      }
      if (url.pathname === "/api/ask" && req.method === "POST") {
        return req.json().then(body => Response.json({ source: "bun", route: "/api/ask", body }));
      }
      if (url.pathname === "/ws") {
        if (server.upgrade(req, { data: { route: "/ws" } })) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return new Response("backend not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ source: "bun", event: "open" }));
      },
      message(ws, message) {
        ws.send(JSON.stringify({ source: "bun", event: "message", message: String(message) }));
      },
      close() {},
    },
  });
  bunServers.push(server);
  return { server, port: server.port };
}

async function startRustGateway(opts: { backendPort?: number } = {}): Promise<GatewayProcess> {
  const gatewayPort = await freePort();
  const backendPort = opts.backendPort ?? await freePort();
  const args = ["serve", "--port", String(gatewayPort), "--backend", String(backendPort)];
  const child = spawn(GATEWAY_BIN, args, {
    cwd: GATEWAY_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RUST_BACKTRACE: "1" },
  });
  children.push(child);

  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
  child.once("exit", (code, signal) => {
    if (code !== null || signal) {
      stderr += `\n[maw-gateway exited code=${code ?? "null"} signal=${signal ?? "null"}]`;
    }
  });

  try {
    await waitForHttp(`http://127.0.0.1:${gatewayPort}/api/health`);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
  }

  return { child, gatewayPort, backendPort };
}

async function closeChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.killed || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolve();
    }, 1_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for websocket message")), TEST_TIMEOUT_MS);
    ws.addEventListener("message", (event) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(event.data)));
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket error"));
    }, { once: true });
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for websocket open")), TEST_TIMEOUT_MS);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket error before open"));
    }, { once: true });
  });
}

beforeAll(() => {
  if (!RUN) return;
  const build = spawnSync("cargo", ["build", "--release"], { cwd: GATEWAY_DIR, encoding: "utf8" });
  if (build.status !== 0) {
    throw new Error(`cargo build --release failed\n${build.stdout}\n${build.stderr}`);
  }
});

afterAll(async () => {
  await Promise.all(children.map(closeChild));
  for (const server of bunServers.splice(0)) server.stop(true);
});

describe.skipIf(!RUN)("Rust gateway reverse proxy integration (#2644)", () => {
  test("native health returns gateway rust and backend metadata", async () => {
    const backend = startBunBackend();
    const gateway = await startRustGateway({ backendPort: backend.port });

    const response = await fetchWithTimeout(`http://127.0.0.1:${gateway.gatewayPort}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      gateway: "rust",
      port: gateway.gatewayPort,
      backend: `bun:${backend.port}`,
    });
  }, TEST_TIMEOUT_MS);

  test("proxied HTTP routes return real Bun backend data", async () => {
    const backend = startBunBackend();
    const gateway = await startRustGateway({ backendPort: backend.port });

    const state = await fetchWithTimeout(`http://127.0.0.1:${gateway.gatewayPort}/api/ui-state`);
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({ source: "bun", ok: true, route: "/api/ui-state" });

    const ask = await fetchWithTimeout(`http://127.0.0.1:${gateway.gatewayPort}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello gateway" }),
    });
    expect(ask.status).toBe(200);
    expect(await ask.json()).toEqual({ source: "bun", route: "/api/ask", body: { prompt: "hello gateway" } });

    const missing = await fetchWithTimeout(`http://127.0.0.1:${gateway.gatewayPort}/not-found`);
    expect(missing.status).toBe(404);
  }, TEST_TIMEOUT_MS);

  test("WebSocket upgrade proxies frames to the Bun backend", async () => {
    const backend = startBunBackend();
    const gateway = await startRustGateway({ backendPort: backend.port });

    const ws = new WebSocket(`ws://127.0.0.1:${gateway.gatewayPort}/ws`);
    try {
      await waitForOpen(ws);
      expect(await nextMessage(ws)).toEqual({ source: "bun", event: "open" });
      ws.send("ping");
      expect(await nextMessage(ws)).toEqual({ source: "bun", event: "message", message: "ping" });
    } finally {
      ws.close();
    }
  }, TEST_TIMEOUT_MS);

  test("proxy routes return an error when the Bun backend is down", async () => {
    const gateway = await startRustGateway();

    const response = await fetchWithTimeout(`http://127.0.0.1:${gateway.gatewayPort}/api/ui-state`);
    expect([502, 503]).toContain(response.status);
  }, TEST_TIMEOUT_MS);

  test("proxy routes return an error after the Bun backend crashes mid-session", async () => {
    const backend = startBunBackend();
    const gateway = await startRustGateway({ backendPort: backend.port });

    const first = await fetchWithTimeout(`http://127.0.0.1:${gateway.gatewayPort}/api/ui-state`);
    expect(first.status).toBe(200);

    backend.server.stop(true);
    const afterCrash = await fetchWithTimeout(`http://127.0.0.1:${gateway.gatewayPort}/api/ui-state`);
    expect([502, 503]).toContain(afterCrash.status);
  }, TEST_TIMEOUT_MS);
});
