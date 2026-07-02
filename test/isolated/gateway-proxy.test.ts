/**
 * Rust gateway reverse-proxy integration contract (#2644).
 *
 * This spec intentionally targets the Phase 3 contract from #2642/#2643:
 *   maw-gateway serve --port <gateway> --backend <bun-backend>
 *
 * It includes the original opt-in direct maw-gateway proxy checks plus a default-on
 * real maw serve --gateway rust E2E that protects full response bodies.
 * Enable the direct proxy checks with:
 *   MAW_RUN_GATEWAY_PROXY_INTEGRATION=1 bun test test/isolated/gateway-proxy.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const RUN = process.env.MAW_RUN_GATEWAY_PROXY_INTEGRATION === "1";
const HAS_CARGO = spawnSync("cargo", ["--version"], { encoding: "utf8" }).status === 0;
const RUN_REAL_E2E = HAS_CARGO && process.env.MAW_SKIP_GATEWAY_REAL_E2E !== "1";
const ROOT = join(import.meta.dir, "../..");
const GATEWAY_DIR = join(ROOT, "packages/maw-gateway");
const GATEWAY_BIN = join(GATEWAY_DIR, "target/release/maw-gateway");
const TEST_TIMEOUT_MS = 10_000;
const BUILD_TIMEOUT_MS = 120_000;

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
  if (!RUN && !RUN_REAL_E2E) return;
  const build = spawnSync("cargo", ["build", "--release"], { cwd: GATEWAY_DIR, encoding: "utf8" });
  if (build.status !== 0) {
    throw new Error(`cargo build --release failed\n${build.stdout}\n${build.stderr}`);
  }
}, BUILD_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all(children.map(closeChild));
  for (const server of bunServers.splice(0)) server.stop(true);
});

const realServePluginNames = [
  "serve-agents",
  "serve-debug",
  "serve-federation",
  "serve-identity",
  "serve-triggers",
  "serve-triggers-mutate",
  "serve-views",
  "serve-worktrees",
  "serve-ws",
] as const;

const realServeCorePluginNames = [
  "serve-blob-reaper",
  "serve-config-health",
  "serve-engine-health-polling",
  "serve-maintenance",
  "serve-peer-startup-warnings",
  "serve-pr-watch",
  "serve-session-reaper",
] as const;

type RealMawServeProcess = {
  child: ChildProcessWithoutNullStreams;
  root: string;
  port: number;
  stdout: () => string;
  stderr: () => string;
};

async function freeAdjacentPortPair(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const first = await freePort();
    if (first >= 65535) continue;
    const second = first + 1;
    const firstServer = createServer();
    const secondServer = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        firstServer.once("error", reject);
        firstServer.listen(first, "127.0.0.1", () => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        secondServer.once("error", reject);
        secondServer.listen(second, "127.0.0.1", () => resolve());
      });
      return first;
    } catch {
      // Try another random base port.
    } finally {
      firstServer.close();
      secondServer.close();
    }
  }
  throw new Error("failed to reserve adjacent test ports");
}

function linkPlugin(source: string, targetRoot: string): void {
  if (!existsSync(source)) throw new Error(`missing serve plugin fixture: ${source}`);
  symlinkSync(source, join(targetRoot, basename(source)), "dir");
}

function writeLargeUiDist(root: string): string {
  const uiDir = join(root, "ui-dist");
  mkdirSync(uiDir, { recursive: true });
  const payload = "x".repeat(1_300);
  writeFileSync(join(uiDir, "index.html"), `<!doctype html><html><head><title>gateway e2e</title></head><body><main id="root">${payload}</main></body></html>`);
  return uiDir;
}

async function startRealMawServe(): Promise<RealMawServeProcess> {
  const root = mkdtempSync(join(tmpdir(), "maw-real-gateway-e2e-"));
  const cwd = join(root, "project");
  const projectPluginDir = join(cwd, ".maw", "plugins");
  const userPluginDir = join(root, "user-plugins");
  const home = join(root, "home");
  mkdirSync(projectPluginDir, { recursive: true });
  mkdirSync(userPluginDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(cwd, ".maw-root"), "");

  for (const name of realServePluginNames) {
    linkPlugin(join(ROOT, "src/vendor/mpr-plugins", name), projectPluginDir);
  }
  for (const name of realServeCorePluginNames) {
    linkPlugin(join(ROOT, "src/vendor-plugins", name), projectPluginDir);
  }

  const port = await freeAdjacentPortPair();
  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, [
    join(ROOT, "src/cli.ts"),
    "serve",
    String(port),
    "--gateway",
    "rust",
    "--force-takeover",
    "--no-scout",
    "--quiet",
  ], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      MAW_HOME: join(home, ".maw"),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      MAW_GATEWAY_BIN: GATEWAY_BIN,
      MAW_PLUGINS_DIR: userPluginDir,
      MAW_UI_DIR: writeLargeUiDist(root),
      MAW_HOT_RELOAD: "0",
      MAW_NO_SCOUT: "1",
      MAW_WARN_STATE_FILE: join(root, "warnings.json"),
      RUST_BACKTRACE: "1",
    },
  });
  children.push(child);
  child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });

  try {
    const health = await waitForHttp(`http://127.0.0.1:${port}/api/health`, TEST_TIMEOUT_MS);
    if (health.status !== 200) throw new Error(`health returned ${health.status}`);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return { child, root, port, stdout: () => stdout, stderr: () => stderr };
}

async function nextJsonMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return await nextMessage(ws) as Record<string, unknown>;
}

async function waitForWsMessageType(ws: WebSocket, type: string, attempts = 5): Promise<Record<string, unknown>> {
  for (let i = 0; i < attempts; i += 1) {
    const message = await nextJsonMessage(ws);
    if (message.type === type) return message;
  }
  throw new Error(`timed out waiting for websocket message type ${type}`);
}

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

describe.skipIf(!RUN_REAL_E2E)("maw serve --gateway rust real E2E (#2652)", () => {
  test("preserves native, proxied, HTML, and WebSocket response bodies", async () => {
    const serve = await startRealMawServe();
    try {
      const baseUrl = `http://127.0.0.1:${serve.port}`;

      const health = await fetchWithTimeout(`${baseUrl}/api/health`);
      const healthBytes = new Uint8Array(await health.arrayBuffer());
      expect(health.status).toBe(200);
      expect(healthBytes.length).toBeGreaterThan(20);
      expect(JSON.parse(Buffer.from(healthBytes).toString("utf8"))).toMatchObject({
        ok: true,
        gateway: "rust",
        port: serve.port,
        backend: `bun:${serve.port + 1}`,
      });

      const expectedUiState = { gateway: "rust", issue: 2652, body: "proxied bytes" };
      const writeState = await fetchWithTimeout(`${baseUrl}/api/ui-state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(expectedUiState),
      });
      expect(writeState.status).toBe(200);
      expect(await writeState.json()).toEqual({ ok: true });

      const uiState = await fetchWithTimeout(`${baseUrl}/api/ui-state`);
      const uiStateBytes = new Uint8Array(await uiState.arrayBuffer());
      expect(uiState.status).toBe(200);
      expect(uiStateBytes.length).toBeGreaterThan(20);
      expect(JSON.parse(Buffer.from(uiStateBytes).toString("utf8"))).toEqual(expectedUiState);

      const root = await fetchWithTimeout(`${baseUrl}/`);
      const rootBytes = new Uint8Array(await root.arrayBuffer());
      const rootHtml = Buffer.from(rootBytes).toString("utf8");
      expect(root.status).toBe(200);
      expect(root.headers.get("content-type") ?? "").toContain("text/html");
      expect(rootBytes.length).toBeGreaterThan(1_024);
      expect(rootHtml).toContain("gateway e2e");
      expect(rootHtml).toContain('id="root"');

      const ws = new WebSocket(`ws://127.0.0.1:${serve.port}/ws`);
      try {
        await waitForOpen(ws);
        await waitForWsMessageType(ws, "feed-history");
        ws.send(JSON.stringify({ type: "send", target: "maw-gateway-e2e:nope", text: "ping", force: true }));
        const reply = await waitForWsMessageType(ws, "error");
        expect(String(reply.error ?? "")).toBeTruthy();
      } finally {
        ws.close();
      }
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nstdout:\n${serve.stdout()}\nstderr:\n${serve.stderr()}`);
    } finally {
      await closeChild(serve.child);
      rmSync(serve.root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});
