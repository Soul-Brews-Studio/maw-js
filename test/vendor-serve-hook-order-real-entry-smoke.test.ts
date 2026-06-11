import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

type SpawnSyncResult = ReturnType<typeof Bun.spawnSync>;

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
    await Bun.sleep(25);
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
    await Bun.sleep(50);
  }
  throw new Error(`listener leak on port ${port}:\n${last}`);
}

function installSlowServeHook(pluginDir: string): void {
  const dir = join(pluginDir, "zz-slow-serve-hook");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({
    name: "zz-slow-serve-hook",
    version: "1.0.0",
    entry: "./index.ts",
    sdk: "^1.0.0",
    tier: "core",
    weight: 1,
    schemaVersion: 1,
    hooks: { serve: { script: "./index.ts", handler: "serve", policy: "fail-fast" } },
  }));
  writeFileSync(join(dir, "index.ts"), `
    export async function serve(ctx) {
      await Bun.sleep(500);
      ctx.http.route("GET", "/api/slow-hook-ready", () => Response.json({ ok: true }));
      return { ok: true };
    }
  `);
}

async function postInvalidShare(port: number): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}/api/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

describe("serve hook mount order real-entry smoke (#2774)", () => {
  test("core readiness never opens before plugin routes such as /api/share are mounted", async () => {
    const repo = join(import.meta.dir, "..");
    const root = mkdtempSync(join(tmpdir(), "maw-serve-order-2774-"));
    const pluginDir = join(root, "plugins");
    const port = await freePort();
    const env = {
      ...process.env,
      MAW_HOME: join(root, "home"),
      MAW_STATE_DIR: join(root, "state"),
      MAW_CONFIG_DIR: join(root, "config"),
      MAW_PLUGINS_DIR: pluginDir,
      MAW_DISABLE_UPDATE_CHECK: "1",
    };
    let serve: ReturnType<typeof Bun.spawn> | null = null;

    installSlowServeHook(pluginDir);
    try {
      serve = Bun.spawn({
        cmd: ["bun", "src/cli.ts", "serve", String(port), "--force-takeover", "-q"],
        cwd: repo,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      await waitForHttp(`http://127.0.0.1:${port}/api/identity`);
      for (let i = 0; i < 8; i += 1) {
        const response = await postInvalidShare(port);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "target_required" });
      }
    } finally {
      if (serve) {
        serve.kill();
        await serve.exited.catch(() => undefined);
      }
      await waitForNoListener(port);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
