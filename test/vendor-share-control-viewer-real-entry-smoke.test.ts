// @maw-test-isolate
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

type SpawnSyncResult = ReturnType<typeof Bun.spawnSync>;
type Listener = (event?: any) => void;

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

function parseControlShareUrl(output: string, port: number): { slug: string; readToken: string; controlToken: string; url: URL } {
  const raw = output.match(/https?:\/\/\S+/)?.[0];
  if (!raw) throw new Error(`share URL missing from output:\n${output}`);
  const url = new URL(raw);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  const slug = url.pathname.split("/").filter(Boolean).at(-1);
  const params = new URLSearchParams(url.hash.slice(1));
  const readToken = params.get("t") || "";
  const controlToken = params.get("c") || "";
  if (!slug || !readToken || !controlToken) throw new Error(`control share URL missing slug/read/control token: ${url.toString()}`);
  return { slug, readToken, controlToken, url };
}

async function waitForCaptureContains(target: string, needle: string, timeoutMs = 5_000): Promise<string> {
  const started = Date.now();
  let capture = "";
  while (Date.now() - started < timeoutMs) {
    capture = run(["tmux", "capture-pane", "-t", target, "-p", "-S", "-20"], { timeout: 5_000 }).stdout.toString();
    if (capture.includes(needle)) return capture;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for pane ${target} to contain ${JSON.stringify(needle)}\nLast capture:\n${capture}`);
}

async function waitForCaptureLine(target: string, expected: string, timeoutMs = 5_000): Promise<string> {
  const started = Date.now();
  let capture = "";
  while (Date.now() - started < timeoutMs) {
    capture = run(["tmux", "capture-pane", "-t", target, "-p", "-S", "-30"], { timeout: 5_000 }).stdout.toString();
    if (capture.split("\n").some((line) => line.trim() === expected)) return capture;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for pane ${target} to output line ${JSON.stringify(expected)}\nLast capture:\n${capture}`);
}

class FakeClassList {
  private values = new Set<string>();
  constructor(private readonly owner: FakeElement) {}
  add(...tokens: string[]) { for (const token of tokens) this.values.add(token); this.sync(); }
  remove(...tokens: string[]) { for (const token of tokens) this.values.delete(token); this.sync(); }
  toggle(token: string, force?: boolean) {
    const next = force ?? !this.values.has(token);
    if (next) this.values.add(token); else this.values.delete(token);
    this.sync();
    return next;
  }
  contains(token: string) { return this.values.has(token); }
  private sync() { this.owner.className = [...this.values].join(" "); }
}

class FakeElement {
  children: FakeElement[] = [];
  classList = new FakeClassList(this);
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  listeners = new Map<string, Listener[]>();
  textContent = "";
  className = "";
  type = "";
  rows = 0;
  placeholder = "";
  value = "";
  disabled = false;
  constructor(public readonly tagName: string) {}
  appendChild(child: FakeElement) { this.children.push(child); return child; }
  append(...children: FakeElement[]) { for (const child of children) this.appendChild(child); }
  addEventListener(type: string, listener: Listener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }
  dispatch(type: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {}, ...event });
  }
  focus() {}
}

class FakeDocument {
  elements: FakeElement[] = [];
  private byId = new Map<string, FakeElement>();
  constructor(ids: string[]) {
    for (const id of ids) {
      const element = this.createElement("div");
      this.byId.set(id, element);
    }
  }
  createElement(tag: string) {
    const element = new FakeElement(tag.toLowerCase());
    this.elements.push(element);
    return element;
  }
  getElementById(id: string) {
    const existing = this.byId.get(id);
    if (existing) return existing;
    const element = this.createElement("div");
    this.byId.set(id, element);
    return element;
  }
  findByClass(name: string) {
    return this.elements.find((element) => element.className.split(/\s+/).includes(name));
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  listeners = new Map<string, Listener[]>();
  binaryType = "";
  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open", {}));
  }
  addEventListener(type: string, listener: Listener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }
  emit(type: string, event: Record<string, unknown>) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  close() { this.emit("close", { code: 1000, reason: "test" }); }
}

async function runViewerAgainstLiveBackend(viewerHtml: string, shareUrl: URL, paneTarget: string, typed: string): Promise<void> {
  const script = viewerHtml.match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (!script) throw new Error("viewer module script not found");

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    WebSocket: globalThis.WebSocket,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    alert: globalThis.alert,
    confirm: globalThis.confirm,
    fetch: globalThis.fetch,
  } as Record<string, unknown>;
  const document = new FakeDocument(["fallback", "toolbar", "tabs", "tile-toggle", "terms"]);
  const alerts: string[] = [];
  try {
    Object.assign(globalThis, {
      document,
      location: shareUrl,
      WebSocket: FakeWebSocket,
      ResizeObserver: class ResizeObserver { observe() {} disconnect() {} },
      requestAnimationFrame: (fn: () => void) => { queueMicrotask(fn); return 1; },
      alert: (message: string) => { alerts.push(String(message)); },
      confirm: () => true,
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const resolved = typeof input === "string" && input.startsWith("/") ? new URL(input, shareUrl.origin).toString() : input;
        return (previous.fetch as typeof fetch)(resolved as RequestInfo | URL, init);
      },
    });
    (globalThis as any).window = {
      Terminal: undefined,
      addEventListener() {},
      visualViewport: undefined,
      alert: (message: string) => { alerts.push(String(message)); },
      confirm: () => true,
    };

    (0, eval)(script);
    await Bun.sleep(300);
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error("viewer did not create websocket");
    ws.emit("message", {
      data: JSON.stringify({ type: "maw-share-frame", pane: paneTarget, data: "", snapshot: true, dimensions: { cols: 80, rows: 24 } }),
    });
    await Bun.sleep(100);

    const input = document.findByClass("pane-control-input");
    const form = document.findByClass("pane-controls");
    if (!input || !form) throw new Error("viewer did not render control form for #c token");
    input.value = typed;
    input.dispatch("input");
    form.dispatch("submit");
    await Bun.sleep(500);
    if (alerts.length > 0) throw new Error(`viewer control alert: ${alerts.join(" | ")}`);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete (globalThis as any)[key];
      else (globalThis as any)[key] = value;
    }
    FakeWebSocket.instances.length = 0;
  }
}

describe("share control viewer real-entry smoke (#2761)", () => {
  test("real viewer control form signs live serve-control requests and writes to tmux", async () => {
    if (!commandAvailable(["tmux", "-V"])) {
      console.warn("SKIP share control viewer real-entry smoke: tmux binary is unavailable");
      return;
    }

    const repo = join(import.meta.dir, "..");
    const session = `maw-share-control-2761-${process.pid}`;
    let target = "";
    const port = await freePort();
    const home = mkdtempSync(join(tmpdir(), "maw-share-control-2761-"));
    const env = {
      ...process.env,
      MAW_HOME: home,
      MAW_STATE_DIR: join(home, "state"),
      MAW_CONFIG_DIR: join(home, "config"),
      MAW_DISABLE_UPDATE_CHECK: "1",
    };
    const output = `MAW2765_VIEWER_EXECUTED_${process.pid}`;
    const typed = `printf '${output}\\n'`;
    let serve: ReturnType<typeof Bun.spawn> | null = null;

    run(["tmux", "kill-session", "-t", session], { allowFailure: true, timeout: 2_000 });
    try {
      run(["tmux", "new-session", "-d", "-x", "106", "-y", "51", "-s", session, "--", "bash", "-lc", "exec bash --noprofile --norc"], { timeout: 5_000 });
      await Bun.sleep(300);
      target = run(["tmux", "list-panes", "-t", session, "-F", "#{pane_id}"], { timeout: 5_000 }).stdout.toString().trim().split("\n")[0] ?? "";
      if (!target.startsWith("%")) throw new Error(`failed to resolve real smoke pane id for ${session}: ${target || "empty"}`);

      serve = Bun.spawn({ cmd: ["bun", "src/cli.ts", "serve", String(port), "--force-takeover", "-q"], cwd: repo, env, stdout: "pipe", stderr: "pipe" });
      await waitForHttp(`http://127.0.0.1:${port}/api/identity`);

      const shareOut = run(["bun", "src/cli.ts", "share", target, "--control", "--ttl", "120", "--port", String(port)], { cwd: repo, env, timeout: 10_000 }).stdout.toString();
      const { url } = parseControlShareUrl(shareOut, port);
      const viewer = await fetch(url).then((response) => response.text());
      expect(viewer).toContain('params.get("c")');
      expect(viewer).toContain("x-maw-control-signature");
      expect(viewer).toContain("JSON.stringify({ slug, ...body })");

      await runViewerAgainstLiveBackend(viewer, url, target, typed);
      const capture = await waitForCaptureContains(target, typed);
      expect(capture).toContain(typed);
      const executed = await waitForCaptureLine(target, output);
      expect(executed.split("\n").some((line) => line.trim() === output)).toBe(true);
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
