import { describe, expect, test } from "bun:test";

const isWindows = process.platform === "win32";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { signControlAction } from "../src/vendor/mpr-plugins/serve-control/index";

type SpawnSyncResult = ReturnType<typeof Bun.spawnSync>;

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

function parseControlShareUrl(output: string, port: number): { slug: string; controlToken: string } {
  const raw = output.match(/https?:\/\/\S+/)?.[0];
  if (!raw) throw new Error(`share URL missing from output:\n${output}`);
  const url = new URL(raw);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  const slug = url.pathname.split("/").filter(Boolean).at(-1);
  const controlToken = url.hash.match(/[?#&]c=([^&]+)/)?.[1];
  if (!slug || !controlToken) throw new Error(`control share URL missing slug or control token fragment: ${url.toString()}`);
  return { slug, controlToken: decodeURIComponent(controlToken) };
}

async function postControl(port: number, target: string, token: string | undefined, body: Record<string, unknown>, verb = "send"): Promise<Response> {
  const path = `/api/control/${encodeURIComponent(target)}/${verb}`;
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) {
    headers["x-maw-control-token"] = token;
    headers["x-maw-control-signature"] = signControlAction(token, "POST", path, raw);
  }
  return await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers, body: raw });
}

async function waitForPaneTarget(target: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    const result = run(["tmux", "display-message", "-p", "-t", target, "#{pane_id}"], { allowFailure: true, timeout: 2_000 });
    last = result.stdout.toString() + result.stderr.toString();
    if (result.success && last.trim() === target) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for tmux pane target ${target}; last=${JSON.stringify(last)}`);
}

async function waitForCaptureContains(target: string, needle: string, timeoutMs = 5_000): Promise<string> {
  const started = Date.now();
  let capture = "";
  while (Date.now() - started < timeoutMs) {
    const result = run(["tmux", "capture-pane", "-t", target, "-p", "-S", "-30"], { allowFailure: true, timeout: 2_000 });
    capture = result.stdout.toString() + result.stderr.toString();
    if (result.success && capture.includes(needle)) return capture;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for pane ${target} to contain ${JSON.stringify(needle)}\nLast capture:\n${capture}`);
}

async function expectJsonStatus(response: Response, expected: number, context: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    parsed = { raw: text };
  }
  if (response.status !== expected) {
    throw new Error(`${context}: expected HTTP ${expected}, got ${response.status}; body=${text || "<empty>"}`);
  }
  return parsed;
}

describe.skipIf(isWindows)("serve-control real-entry smoke", () => {
  test("maw share --control gates real pane writes with scoped write token", async () => {
    if (!commandAvailable(["tmux", "-V"])) {
      console.warn("SKIP serve-control real-entry smoke: tmux binary is unavailable");
      return;
    }

    const repo = join(import.meta.dir, "..");
    const session = `maw-control-2757-${process.pid}`;
    let target = "";
    const port = await freePort();
    const home = mkdtempSync(join(tmpdir(), "maw-control-2757-"));
    const env = {
      ...process.env,
      MAW_HOME: home,
      MAW_STATE_DIR: join(home, "state"),
      MAW_CONFIG_DIR: join(home, "config"),
      MAW_DISABLE_UPDATE_CHECK: "1",
    };
    const sentinel = `MAW2757-control-${process.pid}`;
    let serve: ReturnType<typeof Bun.spawn> | null = null;

    run(["tmux", "kill-session", "-t", session], { allowFailure: true, timeout: 2_000 });
    try {
      run(["tmux", "new-session", "-d", "-x", "106", "-y", "51", "-s", session, "--", "bash", "-lc", `printf 'ready ${sentinel}\\n'; exec bash --noprofile --norc`], { timeout: 5_000 });
      target = run(["tmux", "list-panes", "-t", session, "-F", "#{pane_id}"], { timeout: 5_000 }).stdout.toString().trim().split("\n")[0] ?? "";
      if (!target.startsWith("%")) throw new Error(`failed to resolve real smoke pane id for ${session}: ${target || "empty"}`);
      await waitForPaneTarget(target);
      await waitForCaptureContains(target, `ready ${sentinel}`);

      serve = Bun.spawn({ cmd: ["bun", "src/cli.ts", "serve", String(port), "--force-takeover", "-q"], cwd: repo, env, stdout: "pipe", stderr: "pipe" });
      await waitForHttp(`http://127.0.0.1:${port}/api/identity`);

      const shareOut = run(["bun", "src/cli.ts", "share", target, "--control", "--encrypt", "--ttl", "120", "--port", String(port)], { cwd: repo, env, timeout: 10_000 }).stdout.toString();
      const { slug, controlToken } = parseControlShareUrl(shareOut, port);

      const noToken = await postControl(port, target, undefined, { slug, text: "blocked" });
      await expectJsonStatus(noToken, 401, "no-token control send");

      const badKey = await postControl(port, target, controlToken, { slug, key: "Space" }, "key");
      await expectJsonStatus(badKey, 400, "disallowed control key");

      const typed = ` ${sentinel}-typed `;
      await waitForPaneTarget(target);
      const send = await postControl(port, target, controlToken, { slug, text: typed, enter: false });
      const sendPayload = await expectJsonStatus(send, 200, "control send literal");
      expect(sendPayload).toMatchObject({ ok: true, enter: false });

      let capture = await waitForCaptureContains(target, typed.trim());
      expect(capture).toContain(typed.trim());

      await waitForPaneTarget(target);
      const cancelDraft = await postControl(port, target, controlToken, { slug, key: "C-c" }, "key");
      await expectJsonStatus(cancelDraft, 200, "control cancel draft");
      await waitForPaneTarget(target);

      const output = `${sentinel}-executed`;
      const execute = await postControl(port, target, controlToken, { slug, text: `printf '${output}\\n'`, enter: true });
      const executePayload = await expectJsonStatus(execute, 200, "control send enter");
      expect(executePayload).toMatchObject({ ok: true, enter: true });

      capture = await waitForCaptureContains(target, output);
      expect(capture.split("\n").some((line) => line.trim() === output)).toBe(true);
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
