import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const parseCalls: string[][] = [];

mock.module("maw-js/cli/parse-args", () => ({
  parseFlags: (args: string[], spec: Record<string, unknown>) => {
    parseCalls.push([...args]);
    const out: Record<string, unknown> & { _: string[] } = { _: [] };
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      const parser = spec[arg];
      if (!parser) {
        out._.push(arg);
      } else if (parser === Boolean) {
        out[arg] = true;
      } else {
        const value = args[++i];
        if (value === undefined) throw new Error(`option requires argument: ${arg}`);
        out[arg] = value;
      }
    }
    return out;
  },
}));

const sdkMock = {
  isInfrastructureChannelSessionName: () => false,
  resolveFleetWindowSessionTarget: () => null,
  resolveSessionTarget: () => null,
  listSessions: async () => [{ name: "neo", windows: [{ index: 0, name: "main", active: true }] }],
  loadConfig: () => ({ port: 3456 }),
  loadFleetCore: () => [],
};

mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk"), () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({ ...realSdk, ...sdkMock }));

const impl = await import("../../src/vendor/mpr-plugins/follow/impl.ts?plugin-follow-standalone");
const { default: followHandler } = await import("../../src/vendor/mpr-plugins/follow/index.ts?plugin-follow-standalone");

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 1;
  binaryType?: BinaryType;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }
}

function deps(overrides: Record<string, unknown> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const onHandlers: Array<[string, () => void]> = [];
  const offHandlers: Array<[string, () => void]> = [];
  return {
    values: { stdout, stderr, onHandlers, offHandlers },
    deps: {
      WebSocketCtor: MockWebSocket as any,
      stdoutWrite: (chunk: string) => stdout.push(chunk),
      stderrWrite: (chunk: string) => stderr.push(chunk),
      processOn: (signal: "SIGINT" | "SIGTERM", handler: () => void) => onHandlers.push([signal, handler]),
      processOff: (signal: "SIGINT" | "SIGTERM", handler: () => void) => offHandlers.push([signal, handler]),
      now: () => Date.parse("2026-06-07T00:00:00Z"),
      setTimeout: (() => 1) as any,
      clearTimeout: (() => {}) as any,
      listSessions: async () => [{ name: "neo", windows: [{ index: 0, name: "main", active: true }] }],
      loadFleet: () => [],
      loadConfig: () => ({ port: 3456 }),
      ...overrides,
    },
  };
}

async function waitForSocket(): Promise<MockWebSocket> {
  for (let i = 0; i < 20; i += 1) {
    const ws = MockWebSocket.instances[0];
    if (ws) return ws;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("websocket was not constructed");
}

beforeEach(() => {
  parseCalls.length = 0;
  MockWebSocket.instances = [];
  delete process.env.MAW_ENGINE_URL;
  delete process.env.MAW_PORT;
});

describe("follow plugin standalone boundary (#2192)", () => {
  test("imports only SDK plus plugin-local/allowed parse boundaries", () => {
    const files = ["index.ts", "impl.ts"].map((file) =>
      readFileSync(join(root, "src/vendor/mpr-plugins/follow", file), "utf8"),
    );
    for (const source of files) {
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|lib|config)(?:\/|")/);
    }
    const combined = files.join("\n");
    expect(combined).toContain('from "maw-js/sdk"');
    expect(combined).toContain('from "maw-js/cli/parse-args"');
    expect(combined).toContain('from "../attach/resolve-attach-target"');
  });

  test("resolves duration helpers", () => {
    expect(impl.parseDurationMs("1.5s")).toBe(1500);
    expect(impl.parseDurationMs("2m30s")).toBe(150000);
    expect(impl.parseDurationMs("bad")).toBeNull();
    expect(impl.replayLinesForDuration(1500)).toBe(2);
  });

  test("cmdFollow attaches, filters chunks, and emits JSON", async () => {
    const d = deps();
    const promise = impl.cmdFollow("neo:main", { since: "2s", json: true, grep: "keep" }, d.deps as any);
    const ws = await waitForSocket();

    ws.onopen?.({});
    ws.onmessage?.({ data: JSON.stringify({ type: "attached" }) });
    ws.onmessage?.({ data: "drop this" });
    ws.onmessage?.({ data: "keep this\n" });
    ws.onmessage?.({ data: JSON.stringify({ type: "detached" }) });

    const result = await promise;

    expect(result).toEqual({ pane: "neo:main", reason: "detached", chunks: 1 });
    expect(ws.url).toBe("ws://127.0.0.1:3456/ws/pty");
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "attach", target: "neo:main", cols: 120, rows: 40, replayLines: 2 });
    expect(d.values.stdout.map((line) => JSON.parse(line))).toEqual([
      { ts: "2026-06-07T00:00:00Z", pane: "neo:main", chunk: "keep this\n" },
    ]);
  });

  test("cmdFollow reports websocket control errors", async () => {
    const d = deps();
    const promise = impl.cmdFollow("neo:main", {}, d.deps as any);
    const ws = await waitForSocket();

    ws.onopen?.({});
    ws.onmessage?.({ data: JSON.stringify({ type: "error", message: "boom" }) });

    await expect(promise).rejects.toThrow("boom");
    expect(d.values.stderr).toEqual(["follow: boom\n"]);
  });

  test("handler parses CLI flags on validation failures and validates API target", async () => {
    const badCli = await followHandler({ source: "cli", args: ["--json"] } as any);
    expect(badCli).toEqual({ ok: false, error: impl.FOLLOW_USAGE });
    expect(parseCalls).toEqual([["--json"]]);

    const missing = await followHandler({ source: "api", args: {} } as any);
    expect(missing).toEqual({ ok: false, error: "target is required" });
  });
});
