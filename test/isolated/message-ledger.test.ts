import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildMessageLifecycleFeedEvent } from "../../src/lib/message-events";
import { listMessageLedgerEvents, messageLedgerDbPath, pruneMessageLedgerEvents, recordMessageLedgerEvent } from "../../src/vendor/mpr-plugins/messages/ledger";
import messagesHandler, { messagesEngineFetch, onEvent } from "../../src/vendor/mpr-plugins/messages/index";
import { messagesHtml, messagesView } from "../../src/views/messages";
import type { FeedEvent } from "../../src/lib/feed";

let tmp: string;
let configDir: string;
let dataDir: string;
const prevConfig = process.env.MAW_CONFIG_DIR;
const prevData = process.env.MAW_DATA_DIR;
const prevHome = process.env.MAW_HOME;
const prevKeepLast = process.env.MAW_MESSAGE_KEEP_LAST;
const prevMaxAgeDays = process.env.MAW_MESSAGE_MAX_AGE_DAYS;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "maw-message-ledger-"));
  configDir = join(tmp, "config");
  dataDir = join(tmp, "data");
  delete process.env.MAW_HOME;
  delete process.env.MAW_MESSAGE_KEEP_LAST;
  delete process.env.MAW_MESSAGE_MAX_AGE_DAYS;
  process.env.MAW_CONFIG_DIR = configDir;
  process.env.MAW_DATA_DIR = dataDir;
});

afterEach(() => {
  if (prevConfig === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = prevConfig;
  if (prevData === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prevData;
  if (prevHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = prevHome;
  if (prevKeepLast === undefined) delete process.env.MAW_MESSAGE_KEEP_LAST;
  else process.env.MAW_MESSAGE_KEEP_LAST = prevKeepLast;
  if (prevMaxAgeDays === undefined) delete process.env.MAW_MESSAGE_MAX_AGE_DAYS;
  else process.env.MAW_MESSAGE_MAX_AGE_DAYS = prevMaxAgeDays;
  rmSync(tmp, { recursive: true, force: true });
});

describe("message lifecycle event builder", () => {
  test("builds a structured MessageSend feed event", () => {
    const event = buildMessageLifecycleFeedEvent({
      id: "m1",
      ts: "2026-05-16T01:02:03.000Z",
      direction: "outbound",
      state: "delivered",
      channel: "hey",
      route: "local",
      from: "m5:mawjs-codex",
      to: "m5:mawjs-oracle",
      target: "54-mawjs:mawjs-oracle.0",
      text: "hello",
      signed: true,
    });

    expect(event.event).toBe("MessageSend");
    expect(event.oracle).toBe("mawjs-codex");
    expect(event.host).toBe("m5");
    expect(event.data).toMatchObject({ id: "m1", from: "m5:mawjs-codex", text: "hello" });
  });
});

describe("messages plugin ledger", () => {
  test("records and filters SQLite rows", () => {
    recordMessageLedgerEvent({
      id: "m1",
      ts: "2026-05-16T01:02:03.000Z",
      direction: "outbound",
      state: "delivered",
      channel: "hey",
      route: "local",
      from: "m5:mawjs-codex",
      to: "m5:mawjs-oracle",
      target: "54-mawjs:mawjs-oracle.0",
      text: "hello sqlite",
      signed: true,
    });
    recordMessageLedgerEvent({
      id: "m2",
      ts: "2026-05-16T01:03:03.000Z",
      direction: "inbound",
      state: "failed",
      channel: "api-send",
      route: "local",
      from: "m5:mawjs-oracle",
      to: "m5:mawjs-codex",
      text: "blocked",
      error: "pane not idle",
      signed: true,
    });

    expect(messageLedgerDbPath()).toBe(join(dataDir, "message-ledger.sqlite"));
    expect(listMessageLedgerEvents({ limit: 10 })).toHaveLength(2);
    expect(listMessageLedgerEvents({ state: "failed" })).toMatchObject([{ id: "m2", error: "pane not idle" }]);
    expect(listMessageLedgerEvents({ q: "sqlite" })).toMatchObject([{ id: "m1" }]);
  });

  test("hook persists MessageDeliver structured feed events", async () => {
    const event = buildMessageLifecycleFeedEvent({
      id: "m3",
      ts: "2026-05-16T01:04:03.000Z",
      direction: "inbound",
      state: "delivered",
      channel: "api-send",
      route: "local",
      from: "m5:mawjs-oracle",
      to: "m5:mawjs-codex",
      target: "54-mawjs:mawjs-codex.0",
      text: "inbound hello",
      lastLine: "received",
      signed: true,
    }) as FeedEvent;

    await onEvent(event);

    expect(listMessageLedgerEvents({ direction: "inbound" })).toMatchObject([
      { id: "m3", state: "delivered", lastLine: "received" },
    ]);
  });

  test("prunes oldest rows when message retention is exceeded", () => {
    process.env.MAW_MESSAGE_KEEP_LAST = "3";
    process.env.MAW_MESSAGE_MAX_AGE_DAYS = "9999";

    for (let i = 1; i <= 5; i += 1) {
      recordMessageLedgerEvent({
        id: `retention-${i}`,
        ts: `2026-05-16T01:0${i}:00.000Z`,
        direction: "outbound",
        state: "delivered",
        channel: "hey",
        route: "local",
        from: "m5:mawjs-codex",
        to: "m5:mawjs-oracle",
        text: `retention ${i}`,
      });
    }

    expect(listMessageLedgerEvents({ limit: 10 }).map(row => row.id)).toEqual([
      "retention-5",
      "retention-4",
      "retention-3",
    ]);

    process.env.MAW_MESSAGE_KEEP_LAST = "2";
    expect(pruneMessageLedgerEvents()).toMatchObject({ removed: 1, retained: 2 });
    expect(listMessageLedgerEvents({ limit: 10 }).map(row => row.id)).toEqual([
      "retention-5",
      "retention-4",
    ]);
  });
});

describe("messages browser view", () => {
  test("serves a standalone page backed by /api/messages", async () => {
    const response = await messagesView.request("/");
    const html = await response.text();

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("maw messages");
    expect(html).toContain("/api/messages");
    expect(html).toContain("message ledger");
  });

  test("renders ledger rows with textContent, not innerHTML", () => {
    const html = messagesHtml();

    expect(html).toContain("textContent");
    expect(html).not.toContain("innerHTML");
  });
});

describe("messages engine serve surface", () => {
  test("serves health, query, and event ingestion endpoints", async () => {
    const health = await messagesEngineFetch(new Request("http://plugin.local/health"));
    await expect(health.json()).resolves.toMatchObject({ ok: true, plugin: "messages" });

    const event = buildMessageLifecycleFeedEvent({
      id: "engine-1",
      ts: "2026-05-16T01:05:03.000Z",
      direction: "outbound",
      state: "delivered",
      channel: "hey",
      route: "local",
      from: "m5:mawjs-codex",
      to: "m5:mawjs-oracle",
      text: "engine event",
      signed: true,
    }) as FeedEvent;

    const ingest = await messagesEngineFetch(new Request("http://plugin.local/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }));
    await expect(ingest.json()).resolves.toMatchObject({ ok: true, recorded: true });

    const ignored = await messagesEngineFetch(new Request("http://plugin.local/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "Notification", message: "ignore" }),
    }));
    await expect(ignored.json()).resolves.toMatchObject({ ok: true, recorded: false });

    const query = await messagesEngineFetch(new Request("http://plugin.local/?limit=5&q=engine"));
    await expect(query.json()).resolves.toMatchObject({
      ok: true,
      total: 1,
      source: "sqlite",
      messages: [{ id: "engine-1", text: "engine event" }],
    });
  });
});

describe("messages engine supervisor CLI", () => {
  function engineStub(registrations: Array<Record<string, unknown>> = []) {
    return Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/api/_engine/registrations") {
          return Response.json({ ok: true, registrations });
        }
        if (req.method === "POST" && url.pathname === "/api/_engine/unregister") {
          registrations.length = 0;
          return Response.json({ ok: true, removed: true });
        }
        return Response.json({ ok: false, error: "not_found" }, { status: 404 });
      },
    });
  }

  test("reports stopped detached status with supervisor paths", async () => {
    process.env.MAW_HOME = tmp;
    const engine = engineStub();
    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["status", "--engine", `http://127.0.0.1:${engine.port}`],
      });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("maw messages serve: stopped");
      expect(result.output).toContain(`engine: http://127.0.0.1:${engine.port}`);
      expect(result.output).toContain(join(tmp, "engine-plugins", "messages.log"));
    } finally {
      engine.stop(true);
    }
  });

  test("stop removes stale detached pid files", async () => {
    process.env.MAW_HOME = tmp;
    mkdirSync(join(tmp, "engine-plugins"), { recursive: true });
    const stalePidFile = join(tmp, "engine-plugins", "messages.pid");
    writeFileSync(stalePidFile, "999999\n", "utf-8");
    const engine = engineStub();
    try {
      const result = await messagesHandler({
        source: "cli",
        args: ["stop", "--engine", `http://127.0.0.1:${engine.port}`],
      });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("maw messages serve already stopped");
      expect(result.output).toContain("removed stale pid file");
      expect(existsSync(stalePidFile)).toBe(false);
    } finally {
      engine.stop(true);
    }
  });
});
