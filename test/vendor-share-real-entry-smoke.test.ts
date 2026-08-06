import { describe, expect, test } from "bun:test";

const isWindows = process.platform === "win32";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

import { decryptShareFrame, deriveShareKey, hashShareSecret } from "../src/vendor/mpr-plugins/share/crypto";

type SpawnSyncResult = ReturnType<typeof Bun.spawnSync>;

type SmokeFrame = {
  type: string;
  pane: string;
  data: string;
  snapshot?: boolean;
  dimensions?: { cols?: number; rows?: number };
};

function run(cmd: string[], options: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number; allowFailure?: boolean } = {}): SpawnSyncResult {
  const result = Bun.spawnSync({
    cmd,
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeout ?? 10_000,
  });
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
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate tcp port")));
        return;
      }
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

async function waitForTmuxCaptureContains(target: string, expected: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    const result = run(["tmux", "capture-pane", "-p", "-t", target], { allowFailure: true, timeout: 2_000 });
    last = result.stdout.toString() + result.stderr.toString();
    if (result.success && last.includes(expected)) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for tmux capture to contain ${JSON.stringify(expected)}; last=${JSON.stringify(last)}`);
}

function parseShareUrl(output: string, port: number): { slug: string; secret: string } {
  const raw = output.match(/https?:\/\/\S+/)?.[0];
  if (!raw) throw new Error(`share URL missing from output:\n${output}`);
  const url = new URL(raw);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  const slug = url.pathname.split("/").filter(Boolean).at(-1);
  const secret = url.hash.match(/[?#&]k=([^&]+)/)?.[1];
  if (!slug || !secret) throw new Error(`encrypted share URL missing slug or fragment secret: ${url.toString()}`);
  return { slug, secret: decodeURIComponent(secret) };
}

async function firstEncryptedShareFrame(wsUrl: string, secret: string): Promise<{ frame: SmokeFrame; closeCode: number }> {
  const key = deriveShareKey(secret);
  return await new Promise((resolve, reject) => {
    let settled = false;
    let frame: SmokeFrame | null = null;
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(1000, "smoke timeout"); } catch { /* ignore */ }
      reject(new Error("timed out waiting for encrypted share websocket frame"));
    }, 10_000);

    ws.binaryType = "arraybuffer";
    ws.onmessage = (event) => {
      if (settled || frame) return;
      try {
        const bytes = event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : event.data instanceof Uint8Array
            ? event.data
            : new Uint8Array(event.data as ArrayBufferLike);
        const plaintext = new TextDecoder().decode(decryptShareFrame(key, bytes));
        frame = JSON.parse(plaintext) as SmokeFrame;
        ws.close(1000, "smoke ok");
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        try { ws.close(1000, "smoke parse failure"); } catch { /* ignore */ }
        reject(error);
      }
    };
    ws.onclose = (event) => {
      if (settled) return;
      if (!frame && (event.code === 1008 || event.code === 1011)) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`share websocket closed before frame: ${event.code} ${event.reason}`));
        return;
      }
      if (frame) {
        settled = true;
        clearTimeout(timer);
        resolve({ frame, closeCode: event.code });
      }
    };
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("share websocket error before first frame"));
    };
  });
}

describe.skipIf(isWindows)("share real-entry smoke", () => {
  test("encrypted maw share streams a real tmux snapshot over the real serve websocket", async () => {
    if (!commandAvailable(["tmux", "-V"])) {
      console.warn("SKIP share real-entry smoke: tmux binary is unavailable");
      return;
    }

    const repo = join(import.meta.dir, "..");
    const session = `maw-share-2748-${process.pid}`;
    let target = "";
    const port = await freePort();
    const home = mkdtempSync(join(tmpdir(), "maw-share-2748-"));
    const env = {
      ...process.env,
      MAW_HOME: home,
      MAW_STATE_DIR: join(home, "state"),
      MAW_CONFIG_DIR: join(home, "config"),
      MAW_DISABLE_UPDATE_CHECK: "1",
    };
    const sentinel = `MAW2748 real-entry ${process.pid}`;
    let serve: ReturnType<typeof Bun.spawn> | null = null;

    run(["tmux", "kill-session", "-t", session], { allowFailure: true, timeout: 2_000 });
    try {
      run(["tmux", "new-session", "-d", "-x", "106", "-y", "51", "-s", session, "--", "bash", "-lc", `printf '${sentinel}\\nline-two\\n'; sleep 120`], { timeout: 5_000 });
      await Bun.sleep(300);
      target = run(["tmux", "list-panes", "-t", session, "-F", "#{pane_id}"], { timeout: 5_000 }).stdout.toString().trim().split("\n")[0] ?? "";
      if (!target.startsWith("%")) throw new Error(`failed to resolve real smoke pane id for ${session}: ${target || "empty"}`);
      await waitForTmuxCaptureContains(target, sentinel);

      serve = Bun.spawn({
        cmd: ["bun", "src/cli.ts", "serve", String(port), "--force-takeover", "-q"],
        cwd: repo,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      await waitForHttp(`http://127.0.0.1:${port}/api/identity`);

      const shareOut = run(["bun", "src/cli.ts", "share", target, "--encrypt", "--ttl", "120", "--port", String(port)], { cwd: repo, env, timeout: 10_000 }).stdout.toString();
      const { slug, secret } = parseShareUrl(shareOut, port);
      const proof = hashShareSecret(secret);
      const wsUrl = `ws://127.0.0.1:${port}/ws/share/${encodeURIComponent(slug)}?h=${encodeURIComponent(proof)}`;
      const { frame, closeCode } = await firstEncryptedShareFrame(wsUrl, secret);

      expect(closeCode).not.toBe(1008);
      expect(closeCode).not.toBe(1011);
      expect(frame.type).toBe("maw-share-frame");
      expect(frame.pane).toBe(target);
      expect(frame.snapshot).toBe(true);
      expect(frame.data).toContain(sentinel);
      expect(frame.dimensions).toEqual({ cols: 106, rows: 51 });
    } finally {
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
