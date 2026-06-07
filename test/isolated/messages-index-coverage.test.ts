import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as realChild from "child_process";
import type { FeedEvent } from "../../src/lib/feed";
import { buildMessageLifecycleFeedEvent } from "../../src/lib/message-events";
import { messageLedgerDbPath } from "../../src/vendor/mpr-plugins/messages/ledger";

let tmpHome = "";
const savedHome = process.env.MAW_HOME;
const savedEngineUrl = process.env.MAW_ENGINE_URL;
const savedPort = process.env.MAW_PORT;
const savedMessagesPort = process.env.MAW_MESSAGES_PORT;
const savedFetch = global.fetch;
const savedKill = process.kill;
const savedArgv = [...process.argv];
const savedDateNow = Date.now;
const savedBunSleep = Bun.sleep;

const spawnPid: { value: number | null } = { value: 1234 };
let spawnShouldThrow = false;

function ensureEngineDir() {
  mkdirSync(join(tmpHome, "engine-plugins"), { recursive: true });
}

function writeMessagesPid(pid: number | string) {
  ensureEngineDir();
  writeFileSync(join(tmpHome, "engine-plugins", "messages.pid"), `${pid}\n`, "utf-8");
}

mock.module("child_process", () => ({
  ...realChild,
  spawn: () => {
    if (spawnShouldThrow) throw new Error("spawn failure");
    return {
      pid: spawnPid.value,
      unref: () => {},
    } as any;
  },
}));

const { default: messagesHandler, installServeShutdown, messagesEngineFetch, onEvent } = await import("../../src/vendor/mpr-plugins/messages/index");

function makeEngineStub(options: {
  registrations?: Array<Record<string, unknown>>;
  onRegister?: (body: Record<string, unknown>) => void;
  onUnregister?: () => void;
  registerStatus?: number;
  registerText?: string;
}) {
  let registrations = [...(options.registrations ?? [])];
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/_engine/registrations") {
        return Response.json({ ok: true, registrations });
      }
      if (req.method === "POST" && url.pathname === "/api/_engine/register") {
        const body = await req.json().catch(() => ({} as Record<string, unknown>));
        if (options.registerStatus && options.registerStatus >= 400) {
          return new Response(options.registerText ?? "register rejected", { status: options.registerStatus });
        }
        registrations = [body as Record<string, unknown>];
        options.onRegister?.(body as Record<string, unknown>);
        return Response.json({ ok: true, received: true });
      }
      if (req.method === "POST" && url.pathname === "/api/_engine/unregister") {
        registrations = [];
        options.onUnregister?.();
        return Response.json({ ok: true, removed: true });
      }
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    },
  });
}

function mockKillStateful(sequence: Array<"alive" | "dead" | "throw" | "ephem" | "sigterm-noop">) {
  let calls = 0;
  return (pid: number, signal?: string | number) => {
    const state = sequence[Math.min(calls, sequence.length - 1)] ?? "dead";
    calls++;

    if (signal === "SIGTERM" || signal === "SIGINT") {
      if (state === "sigterm-noop" || state === "dead") return true;
      if (state === "throw") throw new Error("sigterm blocked");
      if (state === "ephem") {
        const err: NodeJS.ErrnoException = new Error("permission") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
    }

    if (signal === 0 || signal === undefined) {
      if (state === "alive") return true;
      if (state === "ephem") {
        const err: NodeJS.ErrnoException = new Error("permission") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      const err: NodeJS.ErrnoException = new Error("not found") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }

    return true;
  };
}

function resetSpawnMocks() {
  spawnShouldThrow = false;
  spawnPid.value = 1234;
}

function fastPollingClock() {
  let now = 10_000;
  Date.now = (() => {
    now += 1_000;
    return now;
  }) as typeof Date.now;
  Bun.sleep = (async () => undefined) as typeof Bun.sleep;
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "maw-messages-slice-"));
  process.env.MAW_HOME = tmpHome;
  delete process.env.MAW_ENGINE_URL;
  delete process.env.MAW_PORT;
  delete process.env.MAW_MESSAGES_PORT;
  resetSpawnMocks();
  process.kill = savedKill as typeof process.kill;
  global.fetch = savedFetch;
  Date.now = savedDateNow;
  Bun.sleep = savedBunSleep;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = savedHome;
  if (savedEngineUrl === undefined) delete process.env.MAW_ENGINE_URL;
  else process.env.MAW_ENGINE_URL = savedEngineUrl;
  if (savedPort === undefined) delete process.env.MAW_PORT;
  else process.env.MAW_PORT = savedPort;
  if (savedMessagesPort === undefined) delete process.env.MAW_MESSAGES_PORT;
  else process.env.MAW_MESSAGES_PORT = savedMessagesPort;
  process.argv = [...savedArgv];
  global.fetch = savedFetch;
  process.kill = savedKill;
  Date.now = savedDateNow;
  Bun.sleep = savedBunSleep;
  rmSync(tmpHome, { force: true, recursive: true });
});

describe("messages plugin coverage slice", () => {
  test("handler defaults to text output, formats rows, errors, and last-line annotations", async () => {
    const outbound = buildMessageLifecycleFeedEvent({
      id: "a-1",
      ts: "2026-05-16T01:00:00.000Z",
      direction: "outbound",
      state: "delivered",
      channel: "hey",
      route: "local",
      from: "u/a",
      to: "u/b",
      text: "hello from outbound",
      signed: true,
    });

    const inbound = buildMessageLifecycleFeedEvent({
      id: "a-2",
      ts: "2026-05-16T01:01:00.000Z",
      direction: "inbound",
      state: "failed",
      channel: "hey",
      route: "local",
      from: "u/c",
      to: "u/d",
      text: "received text with many words that should be collapsed and then potentially truncated if very long to test formatter behavior",
      error: "agent timeout",
      lastLine: "all good once more",
      signed: false,
    });

    const weirdTs = {
      event: "MessageSend",
      oracle: "t",
      host: "h",
      data: {
        id: "a-3",
        ts: "not-a-ts",
        direction: "forwarded",
        state: "queued",
        channel: "api",
        route: "mesh",
        from: "u/e",
        to: "u/f",
        target: "agent/f",
        text: "quick ping",
        signed: true,
      },
    } as FeedEvent;

    await onEvent(outbound);
    await onEvent(inbound);
    await onEvent(weirdTs);

    const result = await messagesHandler({ source: "cli", args: [] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("message ledger:");
    expect(result.output).toContain("inbound/local/failed");
    expect(result.output).toContain("agent timeout");
    expect(result.output).toContain("all good once more");
    expect(result.output).toContain("not-a-ts");
  });

  test("api invocation with object args uses json and defaults json mode", async () => {
    const event = buildMessageLifecycleFeedEvent({
      id: "api-json",
      ts: "2026-05-16T02:00:00.000Z",
      direction: "outbound",
      state: "delivered",
      channel: "api",
      route: "local",
      from: "api/sender",
      to: "api/receiver",
      text: "API body",
      signed: true,
    });

    await onEvent(event);
    const result = await messagesHandler({
      source: "api",
      args: { from: "api/", json: "true" } as Record<string, unknown>,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("\"api-json\"");
    expect(result.output).toContain("\"channel\": \"api\"");
  });

  test("cli --json returns parseable payload string", async () => {
    const result = await messagesHandler({ source: "cli", args: ["--json"] });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output!)).toEqual({ ok: true, messages: [], total: 0, dbPath: messageLedgerDbPath() });
  });

  test("cli json query applies all filters before limiting", async () => {
    const matching = buildMessageLifecycleFeedEvent({
      id: "filter-match",
      ts: "2026-05-16T02:30:00.000Z",
      direction: "outbound",
      state: "delivered",
      channel: "hey",
      route: "local",
      from: "node/a",
      to: "node/b",
      text: "needle text",
      signed: true,
    });
    const decoys = [
      buildMessageLifecycleFeedEvent({
        id: "filter-inbound",
        ts: "2026-05-16T02:31:00.000Z",
        direction: "inbound",
        state: "delivered",
        channel: "hey",
        route: "local",
        from: "node/a",
        to: "node/b",
        text: "needle text",
        signed: false,
      }),
      buildMessageLifecycleFeedEvent({
        id: "filter-state",
        ts: "2026-05-16T02:32:00.000Z",
        direction: "outbound",
        state: "failed",
        channel: "hey",
        route: "local",
        from: "node/a",
        to: "node/b",
        text: "needle text",
        signed: true,
      }),
    ];

    await onEvent(decoys[0]);
    await onEvent(matching);
    await onEvent(decoys[1]);

    const result = await messagesHandler({
      source: "cli",
      args: [
        "--json",
        "--limit",
        "1",
        "--from",
        "node/a",
        "--to",
        "node/b",
        "--direction",
        "outbound",
        "--state",
        "delivered",
        "--q",
        "needle",
      ],
    });
    const payload = JSON.parse(result.output!);
    expect(payload.total).toBe(1);
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].id).toBe("filter-match");
  });

  test("messagesEngineFetch exposes health/events/messages endpoints and 404", async () => {
    const health = await messagesEngineFetch(new Request("http://plugin.local/health"));
    const healthBody = await health.json();
    expect(healthBody).toEqual(expect.objectContaining({ ok: true, plugin: "messages" }));

    const ignored = await messagesEngineFetch(new Request("http://plugin.local/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "Notification", message: "noop" }),
    }));
    expect(await ignored.json()).toEqual({ ok: true, recorded: false });

    const notFound = await messagesEngineFetch(new Request("http://plugin.local/other"));
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ ok: false, error: "not_found" });
  });

  test("serve command rejects invalid port before daemonizing", async () => {
    await expect(messagesHandler({ source: "cli", args: ["serve", "--port", "not-a-number"] })).rejects.toThrow("invalid --port");
  });

  test("serve registers in foreground test mode and shutdown hook is idempotent", async () => {
    let registerBody: Record<string, unknown> | undefined;
    const engine = makeEngineStub({
      onRegister(body) {
        registerBody = body;
      },
    });
    const engineUrl = `http://127.0.0.1:${engine.port}`;

    const result = await messagesHandler({
      source: "cli",
      args: ["serve", "--engine", engineUrl, "--port", "0"],
    });

    engine.stop(true);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("maw messages serve → http://127.0.0.1:");
    expect(result.output).toContain(`registered /api/message-ledger on ${engineUrl}`);
    expect(registerBody).toMatchObject({
      plugin: "messages",
      prefix: "/api/message-ledger",
      eventPath: "/events",
      health: "/health",
    });

    const callbacks: Record<string, () => void> = {};
    const stopped: Array<boolean | undefined> = [];
    const unregistered: string[] = [];
    const exits: number[] = [];
    const shutdown = installServeShutdown("http://engine.local", {
      stop: (force?: boolean) => {
        stopped.push(force);
      },
    }, {
      once: ((event: string, callback: () => void) => {
        callbacks[event] = callback;
        return process;
      }) as typeof process.once,
      unregister: async (url: string) => {
        unregistered.push(url);
      },
      exit: ((code?: number) => {
        exits.push(code ?? 0);
        return undefined as never;
      }) as typeof process.exit,
    });

    expect(Object.keys(callbacks).sort()).toEqual(["SIGINT", "SIGTERM"]);
    await shutdown();
    callbacks.SIGTERM();
    await Promise.resolve();
    await Promise.resolve();
    expect(unregistered).toEqual(["http://engine.local"]);
    expect(stopped).toEqual([true]);
    expect(exits).toEqual([0]);
  });

  test("serve foreground reports engine registration failures and stops the server", async () => {
    const engine = makeEngineStub({ registerStatus: 503, registerText: "engine unavailable" });

    const result = await messagesHandler({
      source: "cli",
      args: ["serve", "--engine", `http://127.0.0.1:${engine.port}`, "--port", "0"],
    });

    engine.stop(true);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("engine register failed 503: engine unavailable");
  });

  test("serve --detach returns already-running message when pid + registration exist", async () => {
    const engine = makeEngineStub({
      registrations: [{ plugin: "messages", prefix: "/api/message-ledger", upstream: "unix:///running" }],
    });

    process.argv = ["node", "/usr/local/bin/maw"];
    process.kill = ((pid: number, signal?: string | number) => {
      return signal === 0 ? true : true;
    }) as typeof process.kill;
    writeMessagesPid(999);

    const result = await messagesHandler({
      source: "cli",
      args: ["serve", "--detach", "--engine", `http://127.0.0.1:${engine.port}`],
    });

    engine.stop(true);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("already running");
    expect(result.output).toContain(join(tmpHome, "engine-plugins", "messages.log"));
  });

  test("serve --detach errors when existing live PID lacks registration and does not exit", async () => {
    const engine = makeEngineStub({ registrations: [] });
    process.kill = ((pid: number, signal?: string | number) => {
      if (signal === "SIGTERM" || signal === "SIGINT") {
        const err: NodeJS.ErrnoException = new Error("still alive") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return true;
    }) as typeof process.kill;
    writeMessagesPid(888);

    const result = await messagesHandler({
      source: "cli",
      args: ["serve", "--detach", "--engine", `http://127.0.0.1:${engine.port}`],
    });

    engine.stop(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("has a live PID 888");
    expect(existsSync(join(tmpHome, "engine-plugins", "messages.pid"))).toBe(false);
  });

  test("serve --detach reports spawn failure when child_process.spawn throws", async () => {
    spawnShouldThrow = true;
    const engine = makeEngineStub({ registrations: [] });
    writeMessagesPid(111);

    const result = await messagesHandler({
      source: "cli",
      args: ["serve", "--detach", "--engine", `http://127.0.0.1:${engine.port}`],
    });

    engine.stop(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed to spawn maw messages serve");
  });

  test("serve --detach reports a child process without a pid", async () => {
    spawnPid.value = null;
    const engine = makeEngineStub({ registrations: [] });

    const result = await messagesHandler({
      source: "cli",
      args: ["serve", "--detach", "--engine", `http://127.0.0.1:${engine.port}`],
    });

    engine.stop(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed to spawn maw messages serve: no child PID");
  });

  test("serve --detach waits for registration and succeeds", async () => {
    let registerBody: Record<string, unknown> | undefined;
    const engineWithRegister = makeEngineStub({
      registrations: [],
      onRegister(body) {
        registerBody = body;
      },
    });
    setTimeout(() => {
      if (registerBody === undefined) {
        void fetch(`http://127.0.0.1:${engineWithRegister.port}/api/_engine/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ plugin: "messages", prefix: "/api/message-ledger", upstream: "http://127.0.0.1:0" }),
        }).catch(() => {});
      }
    }, 50);

    const resultPromise = messagesHandler({
      source: "cli",
      args: ["serve", "--detach", "--engine", `http://127.0.0.1:${engineWithRegister.port}`, "--port", "0"],
    });

    const result = await resultPromise;
    engineWithRegister.stop(true);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("maw messages serve detached");
    expect(result.output).toContain("registered: /api/message-ledger on http://127.0.0.1:");
    expect(registerBody?.plugin).toBe("messages");
  });

  test("serve --detach reports registration timeout with pid, log path, and log tail", async () => {
    fastPollingClock();
    const engine = makeEngineStub({ registrations: [] });
    ensureEngineDir();
    writeFileSync(join(tmpHome, "engine-plugins", "messages.log"), `${"x".repeat(1300)}\nlast registration line\n`, "utf-8");

    const result = await messagesHandler({
      source: "cli",
      args: ["serve", "--detach", "--engine", `http://127.0.0.1:${engine.port}`, "--port", "0"],
    });

    engine.stop(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("maw messages serve --detach did not register /api/message-ledger");
    expect(result.error).toContain("pid: 1234");
    expect(result.error).toContain(join(tmpHome, "engine-plugins", "messages.log"));
    expect(result.error).toContain("tail:\n");
    expect(result.error).toContain("last registration line");
  });

  test("serve --detach registration timeout omits missing log tails", async () => {
    let now = 10_000;
    Date.now = (() => {
      now += 1_000;
      return now;
    }) as typeof Date.now;
    Bun.sleep = (async () => {
      rmSync(join(tmpHome, "engine-plugins", "messages.log"), { force: true });
    }) as typeof Bun.sleep;
    const engine = makeEngineStub({ registrations: [] });

    const result = await messagesHandler({
      source: "cli",
      args: ["serve", "--detach", "--engine", `http://127.0.0.1:${engine.port}`, "--port", "0"],
    });

    engine.stop(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("maw messages serve --detach did not register /api/message-ledger");
    expect(result.error).not.toContain("tail:\n");
  });

  test("serve --detach treats rejected registration polls as absent until timeout", async () => {
    fastPollingClock();
    global.fetch = (async () => {
      throw new Error("engine offline");
    }) as typeof fetch;

    const result = await messagesHandler({
      source: "cli",
      args: ["serve", "--detach", "--engine", "http://engine.local", "--port", "0"],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("maw messages serve --detach did not register /api/message-ledger");
    expect(result.error).toContain("pid: 1234");
  });

  test("foreground serve non-test mode reaches the pending wait after registering", async () => {
    const savedTestMode = process.env.MAW_TEST_MODE;
    const originalServe = Bun.serve;
    const originalOnce = process.once;
    const originalExit = process.exit;
    delete process.env.MAW_TEST_MODE;

    const callbacks: Record<string, () => void> = {};
    const stopped: boolean[] = [];
    const exits: number[] = [];
    let registered: Record<string, unknown> | undefined;
    const engine = makeEngineStub({
      onRegister(body) {
        registered = body;
      },
    });
    Bun.serve = ((opts: { port: number }) => ({
      port: opts.port || 45678,
      stop: (force?: boolean) => {
        stopped.push(Boolean(force));
      },
    })) as typeof Bun.serve;
    process.once = ((event: string, callback: () => void) => {
      callbacks[event] = callback;
      return process;
    }) as typeof process.once;
    process.exit = ((code?: number) => {
      exits.push(code ?? 0);
      return undefined as never;
    }) as typeof process.exit;

    try {
      let pendingError: unknown;
      void messagesHandler({
        source: "cli",
        args: ["serve", "--engine", `http://127.0.0.1:${engine.port}`, "--port", "45678"],
      }).catch((err) => {
        pendingError = err;
      });

      for (let i = 0; i < 20 && !registered && !pendingError; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(pendingError).toBeUndefined();
      expect(registered).toMatchObject({ plugin: "messages", upstream: "http://127.0.0.1:45678" });
      expect(Object.keys(callbacks).sort()).toEqual(["SIGINT", "SIGTERM"]);
      callbacks.SIGTERM();
      for (let i = 0; i < 20 && stopped.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(stopped).toEqual([true]);
      expect(exits).toEqual([0]);
    } finally {
      engine.stop(true);
      Bun.serve = originalServe;
      process.once = originalOnce;
      process.exit = originalExit;
      if (savedTestMode === undefined) delete process.env.MAW_TEST_MODE;
      else process.env.MAW_TEST_MODE = savedTestMode;
    }
  });

  test("serve --detach removes stale pid files and uses maw fallback command when argv is missing", async () => {
    spawnPid.value = null;
    process.argv = [""];
    process.kill = ((pid: number, signal?: string | number) => {
      expect(pid).toBe(2468);
      if (signal === 0 || signal === undefined) {
        const err: NodeJS.ErrnoException = new Error("missing") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }) as typeof process.kill;
    writeMessagesPid(2468);
    const engine = makeEngineStub({ registrations: [] });

    const result = await messagesHandler({
      source: "cli",
      args: ["serve", "--detach", "--engine", `http://127.0.0.1:${engine.port}`],
    });

    engine.stop(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed to spawn maw messages serve: no child PID");
    expect(existsSync(join(tmpHome, "engine-plugins", "messages.pid"))).toBe(false);
  });

  test("serve --detach removes a live unregistered pid after it exits before respawn", async () => {
    spawnPid.value = null;
    let probes = 0;
    process.kill = ((pid: number, signal?: string | number) => {
      expect(pid).toBe(9753);
      if (signal === "SIGTERM") return true;
      if (signal === 0 || signal === undefined) {
        probes += 1;
        if (probes <= 2) return true;
        const err: NodeJS.ErrnoException = new Error("gone") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }) as typeof process.kill;
    writeMessagesPid(9753);
    const engine = makeEngineStub({ registrations: [] });

    const result = await messagesHandler({
      source: "cli",
      args: ["serve", "--detach", "--engine", `http://127.0.0.1:${engine.port}`],
    });

    engine.stop(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no child PID");
    expect(existsSync(join(tmpHome, "engine-plugins", "messages.pid"))).toBe(false);
  });

  test("status reports running when pid is alive and registration exists", async () => {
    process.kill = mockKillStateful(["alive"]);
    writeMessagesPid(98765);

    const engine = makeEngineStub({
      registrations: [{
        plugin: "messages",
        prefix: "/api/message-ledger",
        upstream: "unix:///tmp/maw-messages.sock",
      }],
    });

    const result = await messagesHandler({
      source: "cli",
      args: ["status", "--engine", `http://127.0.0.1:${engine.port}`],
    });

    engine.stop(true);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("maw messages serve: running");
    expect(result.output).toContain("registered: /api/message-ledger → unix:///tmp/maw-messages.sock");
  });

  test("status reports stale pid files when the recorded pid is gone", async () => {
    process.kill = mockKillStateful(["dead"]);
    writeMessagesPid(98766);

    const engine = makeEngineStub({ registrations: [] });
    const result = await messagesHandler({
      source: "cli",
      args: ["status", "--engine", `http://127.0.0.1:${engine.port}`],
    });

    engine.stop(true);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("maw messages serve: stopped (PID 98766)");
    expect(result.output).toContain("note: stale pid file present");
  });

  test("status treats rejected registration fetches as unregistered", async () => {
    global.fetch = (async () => {
      throw new Error("engine down");
    }) as typeof fetch;

    const result = await messagesHandler({
      source: "cli",
      args: ["status", "--engine", "http://engine.local"],
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("registered: no");
    expect(result.output).toContain("engine: http://engine.local");
  });

  test("stop sends SIGTERM, waits for exit, and removes pid file", async () => {
    let killCalls = 0;
    process.kill = ((pid: number, signal?: string | number) => {
      killCalls += 1;
      if (signal === 0) {
        if (killCalls > 1) {
          const err: NodeJS.ErrnoException = new Error("gone") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true;
      }
      return true;
    }) as typeof process.kill;

    writeMessagesPid(777);
    const engine = makeEngineStub({ registrations: [] });

    const result = await messagesHandler({
      source: "cli",
      args: ["stop", "--engine", `http://127.0.0.1:${engine.port}`],
    });

    engine.stop(true);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("sent SIGTERM to PID 777");
    expect(result.output).toContain("stopped PID 777");
    expect(existsSync(join(tmpHome, "engine-plugins", "messages.pid"))).toBe(false);
  });

  test("stop reports already-gone live pid when SIGTERM throws", async () => {
    let checks = 0;
    process.kill = ((pid: number, signal?: string | number) => {
      expect(pid).toBe(778);
      if (signal === "SIGTERM") throw new Error("already gone");
      if (signal === 0 || signal === undefined) {
        checks += 1;
        if (checks === 1) return true;
        const err: NodeJS.ErrnoException = new Error("gone") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }) as typeof process.kill;

    writeMessagesPid(778);
    const engine = makeEngineStub({ registrations: [] });

    const result = await messagesHandler({
      source: "cli",
      args: ["stop", "--engine", `http://127.0.0.1:${engine.port}`],
    });

    engine.stop(true);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("PID 778 was already gone (already gone)");
    expect(result.output).toContain("stopped PID 778");
    expect(existsSync(join(tmpHome, "engine-plugins", "messages.pid"))).toBe(false);
  });

  test("stop reports a pid that remains alive after SIGTERM", async () => {
    fastPollingClock();
    process.kill = ((pid: number, signal?: string | number) => {
      expect(pid).toBe(779);
      if (signal === "SIGTERM") return true;
      if (signal === 0 || signal === undefined) return true;
      return true;
    }) as typeof process.kill;

    writeMessagesPid(779);
    const engine = makeEngineStub({ registrations: [] });

    const result = await messagesHandler({
      source: "cli",
      args: ["stop", "--engine", `http://127.0.0.1:${engine.port}`],
    });

    engine.stop(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("sent SIGTERM to PID 779");
    expect(result.error).toContain("PID 779 did not exit after SIGTERM");
    expect(result.error).toContain(join(tmpHome, "engine-plugins", "messages.log"));
  });

  test("stop removes stale pid files and force-unregisters lingering engine registrations", async () => {
    fastPollingClock();
    process.kill = ((pid: number, signal?: string | number) => {
      expect(pid).toBe(780);
      if (signal === 0 || signal === undefined) {
        const err: NodeJS.ErrnoException = new Error("stale") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }) as typeof process.kill;

    writeMessagesPid(780);
    const engine = makeEngineStub({
      registrations: [{ plugin: "messages", prefix: "/api/message-ledger", upstream: "http://127.0.0.1:9" }],
    });

    const result = await messagesHandler({
      source: "cli",
      args: ["stop", "--engine", `http://127.0.0.1:${engine.port}`],
    });

    engine.stop(true);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("maw messages serve already stopped");
    expect(result.output).toContain("removed stale pid file");
    expect(result.output).toContain("forced unregister /api/message-ledger");
    expect(existsSync(join(tmpHome, "engine-plugins", "messages.pid"))).toBe(false);
  });

  test("shutdown hook default unregister path tolerates fetch rejection", async () => {
    const callbacks: Record<string, () => void> = {};
    const stopped: boolean[] = [];
    const exits: number[] = [];
    global.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    installServeShutdown("http://engine.local", {
      stop: (force?: boolean) => {
        stopped.push(Boolean(force));
      },
    }, {
      once: ((event: string, callback: () => void) => {
        callbacks[event] = callback;
        return process;
      }) as typeof process.once,
      timeoutMs: 5,
      warn: (() => {}) as typeof console.warn,
      exit: ((code?: number) => {
        exits.push(code ?? 0);
        return undefined as never;
      }) as typeof process.exit,
    });

    await callbacks.SIGTERM();
    expect(stopped).toEqual([true]);
    expect(exits).toEqual([0]);
  });

  test("shutdown hook retries engine unregister before exiting", async () => {
    const callbacks: Record<string, () => void> = {};
    const stopped: boolean[] = [];
    const exits: number[] = [];
    const warnings: string[] = [];
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      if (calls === 1) throw new Error("engine not ready");
      return Response.json({ ok: true, removed: true });
    }) as typeof fetch;

    installServeShutdown("http://engine.local", {
      stop: (force?: boolean) => {
        stopped.push(Boolean(force));
      },
    }, {
      once: ((event: string, callback: () => void) => {
        callbacks[event] = callback;
        return process;
      }) as typeof process.once,
      timeoutMs: 75,
      warn: ((message?: unknown) => {
        warnings.push(String(message));
      }) as typeof console.warn,
      exit: ((code?: number) => {
        exits.push(code ?? 0);
        return undefined as never;
      }) as typeof process.exit,
    });

    await callbacks.SIGTERM();

    expect(calls).toBe(2);
    expect(warnings).toEqual([]);
    expect(stopped).toEqual([true]);
    expect(exits).toEqual([0]);
  });

  test("shutdown hook does not hang forever when engine unregister stalls", async () => {
    const callbacks: Record<string, () => void> = {};
    const stopped: boolean[] = [];
    const exits: number[] = [];
    const warnings: string[] = [];

    installServeShutdown("http://engine.local", {
      stop: (force?: boolean) => {
        stopped.push(Boolean(force));
      },
    }, {
      once: ((event: string, callback: () => void) => {
        callbacks[event] = callback;
        return process;
      }) as typeof process.once,
      unregister: async () => new Promise(() => undefined),
      timeoutMs: 5,
      warn: ((message?: unknown) => {
        warnings.push(String(message));
      }) as typeof console.warn,
      exit: ((code?: number) => {
        exits.push(code ?? 0);
        return undefined as never;
      }) as typeof process.exit,
    });

    callbacks.SIGINT();
    await Bun.sleep(20);

    expect(warnings.join("\n")).toContain("engine unregister did not confirm");
    expect(stopped).toEqual([true]);
    expect(exits).toEqual([0]);
  });

  test("query string parsing can ignore --limit=non-int and use fallback", async () => {
    const event = buildMessageLifecycleFeedEvent({
      id: "q1",
      ts: "2026-05-16T03:01:00.000Z",
      direction: "outbound",
      state: "delivered",
      channel: "hey",
      route: "local",
      from: "u/limit",
      to: "u/q",
      text: "one",
      signed: true,
    });
    const event2 = buildMessageLifecycleFeedEvent({
      id: "q2",
      ts: "2026-05-16T03:02:00.000Z",
      direction: "outbound",
      state: "delivered",
      channel: "hey",
      route: "local",
      from: "u/limit",
      to: "u/q",
      text: "two",
      signed: true,
    });

    await onEvent(event);
    await onEvent(event2);

    const res = await messagesEngineFetch(new Request(`http://plugin.local/?limit=abc&from=u/limit`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.messages).toHaveLength(2);
  });

  test("default text handler reports an empty ledger in this coverage slice", async () => {
    const result = await messagesHandler({ source: "cli", args: [] });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("no messages recorded");
    expect(result.output).toContain(messageLedgerDbPath());
  });

  test("text output can stream through an invoke writer", async () => {
    const event = buildMessageLifecycleFeedEvent({
      id: "writer-row",
      ts: "2026-05-16T04:00:00.000Z",
      direction: "outbound",
      state: "queued",
      channel: "hey",
      route: "local",
      from: "writer/a",
      to: "writer/b",
      text: "writer path",
      signed: true,
    });

    await onEvent(event);
    const lines: string[] = [];
    const result = await messagesHandler({
      source: "cli",
      args: ["--from", "writer/a"],
      writer: (line: string) => {
        lines.push(line);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("");
    expect(lines.join("\n")).toContain("message ledger: 1 row");
    expect(lines.join("\n")).toContain("writer/a → writer/b");
  });

  test("status uses MAW_PORT when no explicit engine URL is provided", async () => {
    const engine = makeEngineStub({
      registrations: [{
        plugin: "messages",
        prefix: "/api/message-ledger",
        upstream: "http://127.0.0.1:4567",
      }],
    });
    const enginePort = engine.port;
    process.env.MAW_PORT = String(enginePort);
    process.kill = mockKillStateful(["alive"]);
    writeMessagesPid(4321);

    const result = await messagesHandler({ source: "cli", args: ["status"] });

    engine.stop(true);
    expect(result.ok).toBe(true);
    expect(result.output).toContain(`engine: http://127.0.0.1:${enginePort}`);
    expect(result.output).toContain("maw messages serve: running (PID 4321)");
    expect(result.output).toContain("registered: /api/message-ledger → http://127.0.0.1:4567");
  });

});
