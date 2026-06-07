import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const talkToDir = join(root, "src/vendor/mpr-plugins/talk-to");

type FetchCall = { url: string; init?: RequestInit };
type MockResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

let fetchCalls: FetchCall[] = [];
let fetchQueue: Array<MockResponse | Error> = [];
let config: Record<string, unknown> = { oracleUrl: "https://oracle.test" };
let sessions: unknown[] = [];
let resolved: any = { type: "local", target: "alpha:oracle" };
let paneTarget: string | null = "alpha:oracle.0";
let paneCommand = "claude";
let busyGuard = { busy: false, status: "unknown", oracle: "alpha" };
let sendKeysCalls: Array<{ target: string; message: string }> = [];
let hookCalls: Array<{ name: string; payload: unknown }> = [];
let curlCalls: Array<{ url: string; options: any }> = [];
let curlResult: any = { ok: true, status: 200, data: { ok: true, target: "remote-pane" } };
let mkdirCalls: Array<{ path: string; opts?: unknown }> = [];
let appendFileCalls: Array<{ path: string; data: string }> = [];

const sdkMock = {
  loadConfig: () => config,
  listSessions: async () => sessions,
  resolveTarget: () => resolved,
  resolveOraclePane: async () => paneTarget,
  getPaneCommand: async () => paneCommand,
  checkBusyGuard: async () => busyGuard,
  sendKeys: async (target: string, message: string) => { sendKeysCalls.push({ target, message }); },
  runHook: async (name: string, payload: unknown) => { hookCalls.push({ name, payload }); },
  curlFetch: async (url: string, options: any) => { curlCalls.push({ url, options }); return curlResult; },
  mawMessageLogPath: () => "/tmp/maw-talk-to-log/maw-log.jsonl",
};

mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({ ...realSdk, ...sdkMock }));
mock.module("fs/promises", () => ({
  mkdir: async (path: string, opts?: unknown) => { mkdirCalls.push({ path, opts }); },
  appendFile: async (path: string, data: string) => { appendFileCalls.push({ path, data }); },
}));
mock.module("os", () => ({
  hostname: () => "test-host",
}));

const { command, default: talkToHandler } = await import("../../src/vendor/mpr-plugins/talk-to/index.ts?plugin-talk-to-standalone");

const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200): MockResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSources(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function importSpecs(source: string): string[] {
  const specs = new Set<string>();
  const re = /\b(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) specs.add(match[1] ?? match[2]);
  return [...specs];
}

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  fetchCalls = [];
  fetchQueue = [];
  config = { oracleUrl: "https://oracle.test" };
  sessions = [{ name: "alpha", windows: [] }];
  resolved = { type: "local", target: "alpha:oracle" };
  paneTarget = "alpha:oracle.0";
  paneCommand = "claude";
  busyGuard = { busy: false, status: "unknown", oracle: "alpha" };
  sendKeysCalls = [];
  hookCalls = [];
  curlCalls = [];
  curlResult = { ok: true, status: 200, data: { ok: true, target: "remote-pane" } };
  mkdirCalls = [];
  appendFileCalls = [];
  process.env.CLAUDE_AGENT_NAME = "codex-4";
  process.env.CLAUDE_SESSION_ID = "sess-standalone";
  delete process.env.ORACLE_URL;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init });
    const next = fetchQueue.shift();
    if (!next) throw new Error(`missing fetch mock for ${String(input)}`);
    if (next instanceof Error) throw next;
    return next as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CLAUDE_AGENT_NAME;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.ORACLE_URL;
});

describe("talk-to plugin standalone boundary (#2333)", () => {
  test("all talk-to sources use SDK or local/platform imports only", () => {
    const imports = walkSources(talkToDir).flatMap((file) => importSpecs(readFileSync(file, "utf8")));
    const forbidden = imports.filter((spec) =>
      spec.startsWith("maw-js/core/")
      || spec.startsWith("maw-js/commands/shared/")
      || spec.startsWith("maw-js/lib/")
      || spec.startsWith("maw-js/config")
      || spec.startsWith("maw-js/plugin")
      || spec.includes("../../../core")
      || spec.includes("../../../../core"),
    );

    expect(command).toMatchObject({ name: "talk-to" });
    expect(forbidden).toEqual([]);
    expect(imports).toContain("maw-js/sdk");

    const sdk = readFileSync(join(root, "src/sdk/index.ts"), "utf8");
    for (const symbol of ["loadConfig", "resolveOraclePane", "mawMessageLogPath", "checkBusyGuard", "curlFetch"]) {
      expect(sdk).toContain(symbol);
    }
  });

  test("CLI posts to the thread, resolves a local pane, sends keys, hooks, and logs", async () => {
    fetchQueue = [
      jsonResponse({ threads: [{ id: 7, title: "channel:alpha", status: "open" }] }),
      jsonResponse({ thread_id: 7, message_id: 11, status: "ok" }),
      jsonResponse({ thread: { id: 7, title: "channel:alpha", status: "open", created_at: "now" }, messages: [{ id: 1, role: "user", content: "hi", created_at: "now" }] }),
    ];

    const result = await talkToHandler({ source: "cli", args: ["alpha", "hello", "there"] } as any);

    expect(result.ok).toBe(true);
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://oracle.test/api/threads?limit=50",
      "https://oracle.test/api/thread",
      "https://oracle.test/api/thread/7",
    ]);
    expect(sendKeysCalls).toHaveLength(1);
    expect(sendKeysCalls[0]).toMatchObject({ target: "alpha:oracle.0" });
    expect(sendKeysCalls[0]?.message).toContain("💬 channel:alpha (#7) — 1 msgs");
    expect(sendKeysCalls[0]?.message).toContain("Message:\nhello there");
    expect(hookCalls).toEqual([{ name: "after_send", payload: { to: "alpha", message: sendKeysCalls[0]?.message } }]);
    expect(mkdirCalls).toEqual([{ path: "/tmp/maw-talk-to-log", opts: { recursive: true } }]);
    expect(appendFileCalls[0]?.path).toBe("/tmp/maw-talk-to-log/maw-log.jsonl");
    expect(appendFileCalls[0]?.data).toContain('"ch":"thread:7"');
    expect(stripAnsi(result.output)).toContain("thread #7 + sent → alpha:oracle.0");
  });

  test("peer targets use signed curlFetch and skip local pane injection", async () => {
    resolved = { type: "peer", node: "remote", target: "neo:main", peerUrl: "http://remote.invalid" };
    fetchQueue = [
      jsonResponse({ threads: [] }),
      jsonResponse({ thread_id: 9, message_id: 22, status: "ok" }),
      jsonResponse({ thread: { id: 9, title: "channel:remote", status: "open", created_at: "now" }, messages: [] }),
    ];

    const result = await talkToHandler({ source: "cli", args: ["remote:neo", "cross", "node"] } as any);

    expect(result.ok).toBe(true);
    expect(sendKeysCalls).toEqual([]);
    expect(curlCalls).toHaveLength(1);
    expect(curlCalls[0]?.url).toBe("http://remote.invalid/api/send");
    expect(JSON.parse(curlCalls[0]?.options.body)).toMatchObject({ target: "neo:main", text: expect.stringContaining("cross node") });
    expect(hookCalls).toHaveLength(1);
    expect(stripAnsi(result.output)).toContain("sent → remote:remote-pane");
  });

  test("usage errors and busy targets remain non-destructive", async () => {
    const usage = await talkToHandler({ source: "cli", args: ["alpha"] } as any);
    expect(usage.ok).toBe(false);
    expect(usage.error).toContain("usage: maw talk-to <agent> <message> [--force]");

    busyGuard = { busy: true, status: "busy", oracle: "alpha" };
    fetchQueue = [
      jsonResponse({ threads: [] }),
      jsonResponse({ thread_id: 10, message_id: 23, status: "ok" }),
      jsonResponse({ thread: { id: 10, title: "channel:alpha", status: "open", created_at: "now" }, messages: [] }),
    ];
    const busy = await talkToHandler({ source: "cli", args: ["alpha", "queued"] } as any);

    expect(busy.ok).toBe(true);
    expect(sendKeysCalls).toEqual([]);
    expect(stripAnsi(busy.output)).toContain("target 'alpha' is busy — message saved to thread only");
  });
});
