import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

type SpawnSyncResult = ReturnType<typeof Bun.spawnSync>;
type PresenceMessage = { type: "presence"; slug: string; count: number; viewers: Array<{ id: string; name: string; joinedAt: number }> };

function run(cmd: string[], options: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number; allowFailure?: boolean } = {}): SpawnSyncResult {
  const result = Bun.spawnSync({ cmd, cwd: options.cwd, env: options.env, stdout: "pipe", stderr: "pipe", timeout: options.timeout ?? 10_000 });
  if (!options.allowFailure && !result.success) {
    throw new Error(`${cmd.join(" ")} failed (${result.exitCode})\nSTDOUT:\n${result.stdout.toString()}\nSTDERR:\n${result.stderr.toString()}`);
  }
  return result;
}

function commandAvailable(cmd: string[]): boolean {
  return run(cmd, { allowFailure: true, timeout: 2_000 }).success;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return server.close(() => reject(new Error("failed to allocate tcp port")));
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  let last = "no attempt";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      last = `${response.status}`;
      if (response.status < 500) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${url}; last=${last}`);
}

async function waitForShareApi(port: number, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  let last = "no attempt";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      last = `${response.status}`;
      if (response.status === 400) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for share API on ${port}; last=${last}`);
}

async function waitForNoListener(port: number, timeoutMs = 5_000): Promise<void> {
  if (!commandAvailable(["bash", "-lc", "command -v lsof >/dev/null"])) return;
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    const result = run(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { allowFailure: true, timeout: 2_000 });
    last = result.stdout.toString() + result.stderr.toString();
    if (!result.success || last.trim() === "") return;
    await Bun.sleep(100);
  }
  throw new Error(`listener leak on port ${port}:\n${last}`);
}

function parseShareUrl(output: string, port: number): { slug: string; token: string } {
  const raw = output.match(/https?:\/\/\S+/)?.[0];
  if (!raw) throw new Error(`share URL missing from output:\n${output}`);
  const url = new URL(raw);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  const slug = url.pathname.split("/").filter(Boolean).at(-1);
  const token = url.hash.match(/[?#&]t=([^&]+)/)?.[1];
  if (!slug || token === undefined) throw new Error(`share URL missing slug or token fragment: ${url.toString()}`);
  return { slug, token: decodeURIComponent(token) };
}

function openPresence(url: string): { ws: WebSocket; next: () => Promise<PresenceMessage>; close: () => Promise<CloseEvent> } {
  const queue: PresenceMessage[] = [];
  const waiters: Array<(message: PresenceMessage) => void> = [];
  let closeEvent: CloseEvent | null = null;
  let closeResolve: ((event: CloseEvent) => void) | null = null;
  const closed = new Promise<CloseEvent>((resolve) => { closeResolve = resolve; });
  const ws = new WebSocket(url);
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as PresenceMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  };
  ws.onclose = (event) => {
    closeEvent = event;
    closeResolve?.(event);
  };
  ws.onerror = () => {
    if (!closeEvent) {
      closeEvent = new CloseEvent("close", { code: 1006, reason: "websocket error" });
      closeResolve?.(closeEvent);
    }
  };
  return {
    ws,
    next: () => new Promise((resolve, reject) => {
      const queued = queue.shift();
      if (queued) return resolve(queued);
      const timer = setTimeout(() => reject(new Error(`timed out waiting for presence message from ${url}`)), 10_000);
      waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    }),
    close: async () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, "smoke done");
      return await closed;
    },
  };
}

async function waitForClose(url: string): Promise<CloseEvent> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(`timed out waiting for websocket close from ${url}`));
    }, 10_000);
    ws.onclose = (event) => {
      clearTimeout(timer);
      resolve(event);
    };
    ws.onerror = () => {
      // Bun will still emit close for failed handshakes; leave close handler authoritative.
    };
  });
}

describe("share-presence real-entry smoke", () => {
  test("maw share --presence broadcasts web viewer join and leave through real serve websocket", async () => {
    if (!commandAvailable(["tmux", "-V"])) {
      console.warn("SKIP share-presence real-entry smoke: tmux binary is unavailable");
      return;
    }

    const repo = join(import.meta.dir, "..");
    const session = `maw-presence-2773-${process.pid}`;
    let target = "";
    const port = await freePort();
    const home = mkdtempSync(join(tmpdir(), "maw-presence-2773-"));
    const env = {
      ...process.env,
      MAW_HOME: home,
      MAW_STATE_DIR: join(home, "state"),
      MAW_CONFIG_DIR: join(home, "config"),
      MAW_DISABLE_UPDATE_CHECK: "1",
    };
    let serve: ReturnType<typeof Bun.spawn> | null = null;
    let alice: ReturnType<typeof openPresence> | null = null;
    let bob: ReturnType<typeof openPresence> | null = null;

    run(["tmux", "kill-session", "-t", session], { allowFailure: true, timeout: 2_000 });
    try {
      run(["tmux", "new-session", "-d", "-x", "80", "-y", "24", "-s", session, "--", "bash", "-lc", "printf 'presence ready\\n'; sleep 120"], { timeout: 5_000 });
      await Bun.sleep(300);
      target = run(["tmux", "list-panes", "-t", session, "-F", "#{pane_id}"], { timeout: 5_000 }).stdout.toString().trim().split("\n")[0] ?? "";
      if (!target.startsWith("%")) throw new Error(`failed to resolve real smoke pane id for ${session}: ${target || "empty"}`);

      serve = Bun.spawn({ cmd: ["bun", "src/cli.ts", "serve", String(port), "--force-takeover", "-q"], cwd: repo, env, stdout: "pipe", stderr: "pipe" });
      await waitForHttp(`http://127.0.0.1:${port}/api/identity`);
      await waitForShareApi(port);

      const shareOut = run(["bun", "src/cli.ts", "share", target, "--presence", "--ttl", "120", "--port", String(port)], { cwd: repo, env, timeout: 10_000 }).stdout.toString();
      const { slug, token } = parseShareUrl(shareOut, port);
      const metadata = await fetch(`http://127.0.0.1:${port}/api/share/${encodeURIComponent(slug)}?t=${encodeURIComponent(token)}`);
      expect(metadata.status).toBe(200);
      await expect(metadata.json()).resolves.toMatchObject({ presence: true, readOnly: true });

      alice = openPresence(`ws://127.0.0.1:${port}/ws/share/${encodeURIComponent(slug)}/presence?t=${encodeURIComponent(token)}&name=Alice%00%0A`);
      const one = await alice.next();
      expect(one).toMatchObject({ type: "presence", slug, count: 1 });
      expect(one.viewers).toHaveLength(1);
      expect(one.viewers[0].name).toBe("Alice");
      expect(one.viewers[0].id).toMatch(/^v_/);

      bob = openPresence(`ws://127.0.0.1:${port}/ws/share/${encodeURIComponent(slug)}/presence?t=${encodeURIComponent(token)}&name=${encodeURIComponent("Bob".repeat(30))}`);
      const aliceSeesTwo = await alice.next();
      const bobSeesTwo = await bob.next();
      for (const message of [aliceSeesTwo, bobSeesTwo]) {
        expect(message.count).toBe(2);
        expect(message.viewers.map((viewer) => viewer.name)).toEqual(["Alice", "Bob".repeat(16).slice(0, 48)]);
        expect(new Set(message.viewers.map((viewer) => viewer.id)).size).toBe(2);
      }

      await bob.close();
      bob = null;
      const aliceSeesLeave = await alice.next();
      expect(aliceSeesLeave.count).toBe(1);
      expect(aliceSeesLeave.viewers.map((viewer) => viewer.name)).toEqual(["Alice"]);

      const plainShareOut = run(["bun", "src/cli.ts", "share", target, "--ttl", "120", "--port", String(port)], { cwd: repo, env, timeout: 10_000 }).stdout.toString();
      const plain = parseShareUrl(plainShareOut, port);
      const closed = await waitForClose(`ws://127.0.0.1:${port}/ws/share/${encodeURIComponent(plain.slug)}/presence?t=${encodeURIComponent(plain.token)}&name=blocked`);
      expect(closed.code).toBe(1008);
    } finally {
      if (bob) await bob.close().catch(() => undefined);
      if (alice) await alice.close().catch(() => undefined);
      if (serve) {
        serve.kill();
        await serve.exited.catch(() => undefined);
      }
      run(["tmux", "kill-session", "-t", session], { allowFailure: true, timeout: 2_000 });
      await waitForNoListener(port);
      const sessionCheck = run(["tmux", "has-session", "-t", session], { allowFailure: true, timeout: 2_000 });
      expect(sessionCheck.success).toBe(false);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
