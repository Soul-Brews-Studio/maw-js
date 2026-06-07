import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const savedHome = process.env.MAW_HOME;
let tmpHome = "";

const messages = await import("../../src/vendor/mpr-plugins/messages/index.ts?vendor-messages-engine-fetch-coverage");

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "maw-messages-engine-fetch-"));
  process.env.MAW_HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = savedHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("vendor messages engine fetch coverage", () => {
  test("health and unknown routes return structured responses", async () => {
    const health = await messages.messagesEngineFetch(new Request("http://messages.test/health"));
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ ok: true, plugin: "messages" });

    const miss = await messages.messagesEngineFetch(new Request("http://messages.test/nope"));
    expect(miss.status).toBe(404);
    await expect(miss.json()).resolves.toEqual({ ok: false, error: "not_found" });
  });

  test("events endpoint records only valid message lifecycle events", async () => {
    const invalid = await messages.messagesEngineFetch(new Request("http://messages.test/events", {
      method: "POST",
      body: "not-json",
    }));
    await expect(invalid.json()).resolves.toEqual({ ok: true, recorded: false });

    const event = {
      event: "MessageDeliver",
      data: {
        id: "msg-1",
        direction: "outbound",
        state: "delivered",
        channel: "hey",
        route: "local",
        from: "m5:sender",
        to: "white:receiver",
        text: "hello\nworld",
        ts: "2026-05-19T00:00:00.000Z",
        lastLine: "delivered",
      },
    };
    const valid = await messages.messagesEngineFetch(new Request("http://messages.test/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }));
    await expect(valid.json()).resolves.toEqual({ ok: true, recorded: true });

    const listed = await messages.messagesEngineFetch(new Request("http://messages.test/messages?limit=5&from=m5%3Asender&to=white%3Areceiver&direction=outbound&state=delivered&q=world"));
    const payload = await listed.json() as any;
    expect(payload.ok).toBe(true);
    expect(payload.total).toBe(1);
    expect(payload.messages[0]).toMatchObject({ from: "m5:sender", to: "white:receiver", direction: "outbound", state: "delivered" });
    expect(payload.source).toBe("sqlite");
  });

  test("onEvent ignores unrelated feed events and records valid lifecycle events", async () => {
    await messages.onEvent({ event: "Other", data: { nope: true } } as any);
    await messages.onEvent({ event: "MessageFail", data: { nope: true } } as any);
    await messages.onEvent({
      event: "MessageFail",
      data: {
        id: "msg-2",
        direction: "outbound",
        state: "failed",
        channel: "hey",
        route: "local",
        from: "m5:a",
        to: "m5:b",
        text: "boom",
        error: "failed",
        ts: "2026-05-19T00:00:01.000Z",
      },
    } as any);

    const listed = await messages.messagesEngineFetch(new Request("http://messages.test/"));
    const payload = await listed.json() as any;
    expect(payload.total).toBe(1);
    expect(payload.messages[0].state).toBe("failed");
  });
});
