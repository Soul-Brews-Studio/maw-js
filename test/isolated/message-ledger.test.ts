import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildMessageLifecycleFeedEvent } from "../../src/lib/message-events";
import { listMessageLedgerEvents, messageLedgerDbPath, recordMessageLedgerEvent } from "../../src/vendor/mpr-plugins/messages/ledger";
import { messagesEngineFetch, onEvent } from "../../src/vendor/mpr-plugins/messages/index";
import { messagesHtml, messagesView } from "../../src/views/messages";
import type { FeedEvent } from "../../src/lib/feed";

let tmp: string;
const prevConfig = process.env.MAW_CONFIG_DIR;
const prevHome = process.env.MAW_HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "maw-message-ledger-"));
  delete process.env.MAW_HOME;
  process.env.MAW_CONFIG_DIR = tmp;
});

afterEach(() => {
  if (prevConfig === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = prevConfig;
  if (prevHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = prevHome;
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

    expect(messageLedgerDbPath()).toBe(join(tmp, "message-ledger.sqlite"));
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
