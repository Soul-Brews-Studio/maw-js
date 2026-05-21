import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { InvokeResult } from "../../src/plugin/types";

const saved = {
  home: process.env.MAW_HOME,
  config: process.env.MAW_CONFIG_DIR,
  data: process.env.MAW_DATA_DIR,
  engineUrl: process.env.MAW_ENGINE_URL,
  mawPort: process.env.MAW_PORT,
  messagesPort: process.env.MAW_MESSAGES_PORT,
  testMode: process.env.MAW_TEST_MODE,
  kill: process.kill,
  dateNow: Date.now,
  bunSleep: Bun.sleep,
};

let tmpRoot = "";
let tmpHome = "";
let tmpConfig = "";
let tmpData = "";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function supervisorFile(name: string): string {
  return join(tmpHome, "engine-plugins", name);
}

function writePid(pid: number | string): void {
  mkdirSync(join(tmpHome, "engine-plugins"), { recursive: true });
  writeFileSync(supervisorFile("messages.pid"), `${pid}\n`, "utf-8");
}

function fastPollingClock(): void {
  let now = 50_000;
  Date.now = (() => {
    now += 1_000;
    return now;
  }) as typeof Date.now;
  Bun.sleep = (async () => undefined) as typeof Bun.sleep;
}

function engineStub(options: {
  initialRegistration?: Record<string, unknown>;
  unregisterKeepsRegistration?: boolean;
} = {}) {
  let registrations: Array<Record<string, unknown>> = options.initialRegistration ? [options.initialRegistration] : [];
  let unregisterCalls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/_engine/registrations") {
        return Response.json({ ok: true, registrations });
      }
      if (req.method === "POST" && url.pathname === "/api/_engine/register") {
        registrations = [await req.json() as Record<string, unknown>];
        return Response.json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/_engine/unregister") {
        unregisterCalls += 1;
        if (!options.unregisterKeepsRegistration) registrations = [];
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    unregisterCalls: () => unregisterCalls,
  };
}

async function importMessages(tag: string) {
  return import(`../../src/vendor/mpr-plugins/messages/index.ts?messages-ledger-index-extra-${tag}`);
}

async function importLedger(tag: string) {
  return import(`../../src/vendor/mpr-plugins/messages/ledger.ts?messages-ledger-index-extra-${tag}`);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "maw-messages-ledger-index-extra-"));
  tmpHome = join(tmpRoot, "home");
  tmpConfig = join(tmpRoot, "config");
  tmpData = join(tmpRoot, "data");
  process.env.MAW_HOME = tmpHome;
  delete process.env.MAW_CONFIG_DIR;
  delete process.env.MAW_DATA_DIR;
  delete process.env.MAW_ENGINE_URL;
  delete process.env.MAW_PORT;
  delete process.env.MAW_MESSAGES_PORT;
  delete process.env.MAW_TEST_MODE;
  process.kill = saved.kill;
  Date.now = saved.dateNow;
  Bun.sleep = saved.bunSleep;
});

afterEach(() => {
  restoreEnv("MAW_HOME", saved.home);
  restoreEnv("MAW_CONFIG_DIR", saved.config);
  restoreEnv("MAW_DATA_DIR", saved.data);
  restoreEnv("MAW_ENGINE_URL", saved.engineUrl);
  restoreEnv("MAW_PORT", saved.mawPort);
  restoreEnv("MAW_MESSAGES_PORT", saved.messagesPort);
  restoreEnv("MAW_TEST_MODE", saved.testMode);
  process.kill = saved.kill;
  Date.now = saved.dateNow;
  Bun.sleep = saved.bunSleep;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("messages ledger and index extra coverage", () => {
  test("ledger honors MAW_DATA_DIR and maps optional row fields only when present", async () => {
    delete process.env.MAW_HOME;
    process.env.MAW_CONFIG_DIR = tmpConfig;
    process.env.MAW_DATA_DIR = tmpData;
    const ledger = await importLedger("config-dir");

    expect(ledger.messageLedgerDbPath()).toBe(join(tmpData, "message-ledger.sqlite"));

    ledger.recordMessageLedgerEvent({
      id: "full-row",
      ts: "2026-05-19T01:00:00.000Z",
      direction: "forwarded",
      state: "queued",
      channel: "hey",
      route: "relay",
      from: "m5:a",
      to: "white:b",
      target: "oracle-world:c",
      peerUrl: "http://peer.local",
      text: "needle full row",
      error: "waiting",
      lastLine: "queued for relay",
      signed: true,
    });
    ledger.recordMessageLedgerEvent({
      id: "minimal-row",
      ts: "2026-05-19T00:00:00.000Z",
      direction: "inbound",
      state: "delivered",
      channel: "api",
      route: "local",
      from: "clinic:x",
      to: "m5:y",
      text: "minimal row",
    });

    const [full] = ledger.listMessageLedgerEvents({ from: "m5", to: "white", direction: "forwarded", state: "queued", q: "full", limit: 0 });
    expect(full).toMatchObject({
      id: "full-row",
      target: "oracle-world:c",
      peerUrl: "http://peer.local",
      error: "waiting",
      lastLine: "queued for relay",
      signed: true,
    });

    const [minimal] = ledger.listMessageLedgerEvents({ q: "minimal", limit: 100_000 });
    expect(minimal).toMatchObject({ id: "minimal-row", signed: false });
    expect(minimal).not.toHaveProperty("target");
    expect(minimal).not.toHaveProperty("peerUrl");
    expect(minimal).not.toHaveProperty("error");
    expect(minimal).not.toHaveProperty("lastLine");
  });

  test("api query object validates filters, boolish json, and invalid url filters", async () => {
    const messages = await importMessages("api-query");
    await messages.onEvent({
      event: "MessageSend",
      data: {
        id: "api-row",
        ts: "not-a-date",
        direction: "forwarded",
        state: "queued",
        channel: "hey",
        route: "relay",
        from: "m5:from",
        to: "white:to",
        text: "api query text",
      },
    } as any);

    const apiResult = await messages.default({
      source: "api",
      args: { limit: "1", from: "m5", to: "white", direction: "bogus", state: "queued", q: "query", json: "yes" },
    } as any);

    expect(apiResult.ok).toBe(true);
    expect(JSON.parse(apiResult.output).messages).toEqual([expect.objectContaining({ id: "api-row", direction: "forwarded", state: "queued" })]);

    const listed = await messages.messagesEngineFetch(new Request("http://messages.local/messages?limit=bad&direction=nope&state=nope&q=query"));
    const payload = await listed.json() as any;
    expect(payload.total).toBe(1);
    expect(payload.messages[0].id).toBe("api-row");
  });

  test("cli output covers invalid timestamps, inbound and queued formatting", async () => {
    const messages = await importMessages("cli-formatting");
    await messages.onEvent({
      event: "MessageDeliver",
      data: {
        id: "inbound-row",
        ts: "not-a-date",
        direction: "inbound",
        state: "queued",
        channel: "hey",
        route: "local",
        from: "white:sender",
        to: "m5:receiver",
        text: "short text",
      },
    } as any);

    const result = await messages.default({ source: "cli", args: ["--limit", "1"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("not-a-date  … inbound/local/queued  white:sender ← m5:receiver  short text");
  });

  test("serve rejects invalid ports from environment and status uses env engine url without trailing slash", async () => {
    process.env.MAW_MESSAGES_PORT = "65536";
    process.env.MAW_ENGINE_URL = "http://127.0.0.1:9///";
    const messages = await importMessages("invalid-port");

    await expect(messages.default({ source: "cli", args: ["serve"] } as any)).rejects.toThrow("invalid --port: 65536");

    delete process.env.MAW_MESSAGES_PORT;
    const status = await messages.default({ source: "cli", args: ["status"] } as any);
    expect(status.output).toContain("engine: http://127.0.0.1:9");
  });

  test("status falls back to MAW_PORT when MAW_ENGINE_URL is unset", async () => {
    process.env.MAW_PORT = "4567";
    const messages = await importMessages("status-maw-port");

    const status = await messages.default({ source: "cli", args: ["status"] } as any);

    expect(status.ok).toBe(true);
    expect(status.output).toContain("engine: http://127.0.0.1:4567");
  });

  test("serve success can return in test mode and shutdown is idempotent", async () => {
    const engine = engineStub();
    process.env.MAW_TEST_MODE = "1";
    const messages = await importMessages("serve-success-test-mode");

    try {
      const result = await messages.default({ source: "cli", args: ["serve", "--engine", engine.url] } as any);
      expect(result.ok).toBe(true);
      expect(result.output).toContain("maw messages serve → http://127.0.0.1:");
      expect(result.output).toContain(`registered /api/message-ledger on ${engine.url}`);

      const callbacks: Record<string, () => void> = {};
      const stops: Array<boolean | undefined> = [];
      const unregisterCalls: string[] = [];
      const exits: number[] = [];
      const shutdown = messages.installServeShutdown("http://engine.local", {
        stop: (force?: boolean) => {
          stops.push(force);
        },
      }, {
        once: ((event: string, callback: () => void) => {
          callbacks[event] = callback;
          return process;
        }) as typeof process.once,
        unregister: async (url: string) => {
          unregisterCalls.push(url);
        },
        exit: ((code?: number) => {
          exits.push(code ?? 0);
          return undefined as never;
        }) as typeof process.exit,
      });

      expect(Object.keys(callbacks).sort()).toEqual(["SIGINT", "SIGTERM"]);
      shutdown();
      callbacks.SIGINT();
      await Promise.resolve();
      await Promise.resolve();

      expect(unregisterCalls).toEqual(["http://engine.local"]);
      expect(stops).toEqual([true]);
      expect(exits).toEqual([0]);
    } finally {
      engine.stop();
    }
  });

  test("status reports EPERM pids as running and preserves unknown registration fields", async () => {
    const engine = engineStub({ initialRegistration: { plugin: "messages" } });
    writePid(2468);
    process.kill = ((pid: number, signal?: string | number) => {
      expect(pid).toBe(2468);
      expect(signal === 0 || signal === undefined).toBe(true);
      const err = new Error("permission denied") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    }) as typeof process.kill;
    const messages = await importMessages("status-eperm");

    try {
      const result = await messages.default({ source: "cli", args: ["status", "--engine", `${engine.url}/`] } as any);
      expect(result.output).toContain("maw messages serve: running (PID 2468)");
      expect(result.output).toContain("registered: /api/message-ledger → unknown");
    } finally {
      engine.stop();
    }
  });

  test("stop removes stale pid files and force unregisters sticky engine registrations", async () => {
    const engine = engineStub({
      initialRegistration: { plugin: "messages", prefix: "/custom", upstream: "http://127.0.0.1:1" },
      unregisterKeepsRegistration: true,
    });
    writePid(9753);
    process.kill = ((pid: number, signal?: string | number) => {
      expect(pid).toBe(9753);
      expect(signal === 0 || signal === undefined).toBe(true);
      const err = new Error("stale") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }) as typeof process.kill;
    fastPollingClock();
    const messages = await importMessages("stop-sticky");

    try {
      const result = await messages.default({ source: "cli", args: ["stop", "--engine", engine.url] } as any) as InvokeResult;
      expect(result.ok).toBe(true);
      expect(result.output).toContain("maw messages serve already stopped");
      expect(result.output).toContain("removed stale pid file");
      expect(result.output).toContain("forced unregister /api/message-ledger");
      expect(engine.unregisterCalls()).toBeGreaterThanOrEqual(1);
      expect(existsSync(supervisorFile("messages.pid"))).toBe(false);
    } finally {
      engine.stop();
    }
  });
});
