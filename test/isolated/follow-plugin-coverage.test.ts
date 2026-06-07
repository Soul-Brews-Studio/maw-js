import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cmdFollow,
  parseDurationMs,
  replayLinesForDuration,
  resolveFollowTarget,
  followUrlFromConfig,
  type FollowDeps,
} from "../../src/vendor/mpr-plugins/follow/impl";

type Session = { name: string; windows: Array<{ name: string }> };
type TimerHandle = { fn: () => void; active: boolean; ms?: number };

const encode = (text: string) => new TextEncoder().encode(text);
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  binaryType?: BinaryType;
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  message(data: unknown) {
    this.onmessage?.({ data });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const originalEngineUrl = process.env.MAW_ENGINE_URL;
const originalPort = process.env.MAW_PORT;

let sessions: Session[];
let out: string[];
let err: string[];
let timers: TimerHandle[];
let handlers: Partial<Record<"SIGINT" | "SIGTERM", () => void>>;

function deps(overrides: Partial<FollowDeps> = {}): Partial<FollowDeps> {
  return {
    WebSocketCtor: FakeWebSocket as unknown as FollowDeps["WebSocketCtor"],
    loadConfig: (() => ({ port: 4567 })) as FollowDeps["loadConfig"],
    listSessions: async () => sessions as any,
    loadFleet: (() => []) as FollowDeps["loadFleet"],
    stdoutWrite: (chunk) => { out.push(chunk); },
    stderrWrite: (chunk) => { err.push(chunk); },
    now: () => Date.parse("2026-05-21T14:23:45.000Z"),
    setTimeout: ((fn: () => void, ms?: number) => {
      const timer = { fn, active: true, ms };
      timers.push(timer);
      return timer as any;
    }) as typeof setTimeout,
    clearTimeout: ((timer: TimerHandle | null) => {
      if (timer) timer.active = false;
    }) as typeof clearTimeout,
    processOn: (signal, handler) => { handlers[signal] = handler; },
    processOff: (signal, handler) => {
      if (handlers[signal] === handler) delete handlers[signal];
    },
    ...overrides,
  };
}

function restoreEnv() {
  if (originalEngineUrl === undefined) delete process.env.MAW_ENGINE_URL;
  else process.env.MAW_ENGINE_URL = originalEngineUrl;
  if (originalPort === undefined) delete process.env.MAW_PORT;
  else process.env.MAW_PORT = originalPort;
}

beforeEach(() => {
  restoreEnv();
  FakeWebSocket.instances = [];
  sessions = [{ name: "mawjs-codex-oracle", windows: [{ name: "main" }] }];
  out = [];
  err = [];
  timers = [];
  handlers = {};
});

afterEach(() => {
  restoreEnv();
});

describe("maw follow plugin", () => {
  test("parses duration flags, derives replay depth, and builds the PTY websocket URL", () => {
    expect(parseDurationMs("1m30s")).toBe(90_000);
    expect(parseDurationMs("2")).toBe(2_000);
    expect(parseDurationMs("250ms")).toBe(250);
    expect(parseDurationMs("1x")).toBeNull();
    expect(replayLinesForDuration(10 * 60_000)).toBe(600);

    delete process.env.MAW_ENGINE_URL;
    delete process.env.MAW_PORT;
    expect(followUrlFromConfig({ loadConfig: (() => ({ port: 4567 })) as FollowDeps["loadConfig"] })).toBe("ws://127.0.0.1:4567/ws/pty");

    process.env.MAW_PORT = "4568";
    expect(followUrlFromConfig({ loadConfig: (() => ({ port: 4567 })) as FollowDeps["loadConfig"] })).toBe("ws://127.0.0.1:4568/ws/pty");

    process.env.MAW_ENGINE_URL = "https://engine.example:9443/base?token=ignored";
    expect(followUrlFromConfig({ loadConfig: (() => ({ port: 4567 })) as FollowDeps["loadConfig"] })).toBe("wss://engine.example:9443/ws/pty");
  });

  test("resolves attach-style names while preserving explicit tmux pane suffixes", async () => {
    sessions = [{ name: "50-codex", windows: [{ name: "main" }] }];
    expect(await resolveFollowTarget("codex", deps() as any)).toBe("50-codex");
    expect(await resolveFollowTarget("codex:1.2", deps() as any)).toBe("50-codex:1.2");
    expect(await resolveFollowTarget("raw:window", deps() as any)).toBe("raw:window");

    sessions = [{ name: "50-mawjs", windows: [{ name: "mawjs-oracle" }, { name: "mawjs-features" }] }];
    expect(await resolveFollowTarget("mawjs-features", deps() as any)).toBe("50-mawjs:mawjs-features");
    expect(await resolveFollowTarget("mawjs-features:0", deps() as any)).toBe("50-mawjs:mawjs-features.0");
  });

  test("rejects ambiguous attach-style names before opening a websocket", async () => {
    sessions = [
      { name: "50-codex", windows: [{ name: "main" }] },
      { name: "51-codex", windows: [{ name: "main" }] },
    ];

    await expect(resolveFollowTarget("codex", deps() as any)).rejects.toThrow("ambiguous");
  });

  test("follows live chunks by default without requesting scrollback replay", async () => {
    const follow = cmdFollow("mawjs-codex-oracle", {}, deps());
    await flush();

    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: "attach",
      target: "mawjs-codex-oracle",
      replayLines: 0,
    });

    ws.message(encode("hello\n"));
    await flush();
    expect(out.join("")).toBe("hello\n");

    ws.message(JSON.stringify({ type: "detached", target: "mawjs-codex-oracle" }));
    await expect(follow).resolves.toEqual({ pane: "mawjs-codex-oracle", reason: "detached", chunks: 1 });
    expect(handlers).toEqual({});
  });

  test("emits structured JSON chunks and uses --since as bounded replay depth", async () => {
    const follow = cmdFollow("mawjs-codex-oracle", { since: "10m", json: true }, deps());
    await flush();

    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(JSON.parse(ws.sent[0])).toMatchObject({ replayLines: 600 });

    ws.message(encode("history\n"));
    await flush();
    ws.message(JSON.stringify({ type: "detached", target: "mawjs-codex-oracle" }));

    await expect(follow).resolves.toMatchObject({ reason: "detached", chunks: 1 });
    expect(JSON.parse(out[0])).toEqual({
      ts: "2026-05-21T14:23:45Z",
      pane: "mawjs-codex-oracle",
      chunk: "history\n",
    });
  });

  test("decodes binary frame variants and malformed control JSON as output chunks", async () => {
    const follow = cmdFollow("mawjs-codex-oracle", {}, deps());
    await flush();

    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.message(new TextEncoder().encode("bytes\n").buffer);
    await flush();
    ws.message(new DataView(new TextEncoder().encode("view\n").buffer));
    await flush();
    ws.message(new Blob(["blob\n"]));
    await flush();
    ws.message("{");
    await flush();
    ws.message({ unexpected: true });
    await flush();
    ws.message(JSON.stringify({ type: "detached" }));

    await expect(follow).resolves.toEqual({ pane: "mawjs-codex-oracle", reason: "detached", chunks: 5 });
    expect(out).toEqual(["bytes\n", "view\n", "blob\n", "{", "[object Object]"]);
  });

  test("rejects invalid grep patterns before attaching", async () => {
    await expect(cmdFollow("mawjs-codex-oracle", { grep: "[" }, deps())).rejects.toThrow("invalid --grep pattern");
    expect(FakeWebSocket.instances).toEqual([]);
  });

  test("applies grep filtering and exits cleanly after idle", async () => {
    const follow = cmdFollow("mawjs-codex-oracle", { grep: "keep", quitOnIdle: "5s" }, deps());
    await flush();

    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(timers.at(-1)?.ms).toBe(5_000);

    ws.message(encode("drop\n"));
    await flush();
    ws.message(encode("keep\n"));
    await flush();
    expect(out).toEqual(["keep\n"]);

    const activeTimer = [...timers].reverse().find(t => t.active);
    activeTimer?.fn();

    await expect(follow).resolves.toEqual({ pane: "mawjs-codex-oracle", reason: "idle", chunks: 1 });
    expect(ws.sent.at(-1)).toBe(JSON.stringify({ type: "detach" }));
    expect(handlers).toEqual({});
  });

  test("detaches and resolves cleanly on Ctrl-C", async () => {
    const follow = cmdFollow("mawjs-codex-oracle", {}, deps());
    await flush();

    const ws = FakeWebSocket.instances[0];
    ws.open();
    handlers.SIGINT?.();

    await expect(follow).resolves.toEqual({ pane: "mawjs-codex-oracle", reason: "signal", chunks: 0 });
    expect(ws.sent.at(-1)).toBe(JSON.stringify({ type: "detach" }));
    expect(handlers).toEqual({});
  });

  test("cleans up signal handlers on network close", async () => {
    const follow = cmdFollow("mawjs-codex-oracle", {}, deps());
    await flush();

    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.close();

    await expect(follow).resolves.toEqual({ pane: "mawjs-codex-oracle", reason: "closed", chunks: 0 });
    expect(handlers).toEqual({});
  });

  test("surfaces bridge error frames on stderr", async () => {
    const follow = cmdFollow("mawjs-codex-oracle", {}, deps());
    await flush();

    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.message(JSON.stringify({ type: "error", message: "Failed to create PTY session" }));

    await expect(follow).rejects.toThrow("Failed to create PTY session");
    expect(err).toEqual(["follow: Failed to create PTY session\n"]);
  });

  test("surfaces websocket error events with the configured bridge URL", async () => {
    const follow = cmdFollow("mawjs-codex-oracle", {}, deps());
    await flush();

    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.onerror?.({});

    await expect(follow).rejects.toThrow("follow: websocket error: ws://127.0.0.1:4567/ws/pty");
    expect(handlers).toEqual({});
  });
});
