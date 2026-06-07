import { describe, expect, test } from "bun:test";
import {
  buildMessageLifecycleData,
  buildMessageLifecycleFeedEvent,
  isMessageLifecycleData,
  type MessageLifecycleInput,
} from "../src/lib/message-events";

const baseInput: MessageLifecycleInput = {
  id: "msg-1",
  ts: new Date("2026-05-16T01:02:03.000Z"),
  direction: "outbound",
  state: "queued",
  channel: "hey",
  route: "peer",
  from: "m5:mawjs-codex",
  to: "m5:mawjs-oracle",
  target: "54-mawjs:mawjs-oracle.0",
  peerUrl: "http://m5.local:3456",
  text: "hello",
  signed: true,
};

describe("message lifecycle event builders", () => {
  test("buildMessageLifecycleData fills stable fields and optional metadata", () => {
    const data = buildMessageLifecycleData(baseInput);
    expect(data).toEqual({
      id: "msg-1",
      ts: "2026-05-16T01:02:03.000Z",
      direction: "outbound",
      state: "queued",
      channel: "hey",
      route: "peer",
      from: "m5:mawjs-codex",
      to: "m5:mawjs-oracle",
      target: "54-mawjs:mawjs-oracle.0",
      peerUrl: "http://m5.local:3456",
      text: "hello",
      signed: true,
    });
  });

  test("buildMessageLifecycleData normalizes timestamps and truncates long fields", () => {
    const longText = "x".repeat(2_010);
    const longError = "e".repeat(1_010);
    const longLastLine = "l".repeat(1_010);
    const data = buildMessageLifecycleData({
      ...baseInput,
      id: undefined,
      ts: 1_700_000_000_000,
      text: longText,
      error: longError,
      lastLine: longLastLine,
      signed: false,
    });

    expect(data.id).toBeTruthy();
    expect(data.ts).toBe("2023-11-14T22:13:20.000Z");
    expect(data.text).toHaveLength(2_000);
    expect(data.text.endsWith("…")).toBe(true);
    expect(data.error).toHaveLength(1_000);
    expect(data.error?.endsWith("…")).toBe(true);
    expect(data.lastLine).toHaveLength(1_000);
    expect(data.lastLine?.endsWith("…")).toBe(true);
    expect(data.signed).toBe(false);
  });

  test("buildMessageLifecycleFeedEvent maps direction/state to feed metadata", () => {
    const outbound = buildMessageLifecycleFeedEvent(baseInput);
    expect(outbound.event).toBe("MessageSend");
    expect(outbound.host).toBe("m5");
    expect(outbound.oracle).toBe("mawjs-codex");
    expect(outbound.sessionId).toBe("54-mawjs:mawjs-oracle.0");
    expect(outbound.message).toContain("outbound/queued");
    expect(outbound.message).toContain("m5:mawjs-codex → m5:mawjs-oracle");

    const inbound = buildMessageLifecycleFeedEvent({ ...baseInput, direction: "inbound", state: "delivered", to: "white:neo" });
    expect(inbound.event).toBe("MessageDeliver");
    expect(inbound.host).toBe("white");
    expect(inbound.oracle).toBe("neo");

    const failed = buildMessageLifecycleFeedEvent({ ...baseInput, state: "failed", error: "boom" });
    expect(failed.event).toBe("MessageFail");
    expect(failed.message).toContain("error=boom");
  });

  test("buildMessageLifecycleData defaults blank timestamps to now", () => {
    const before = Date.now();
    const data = buildMessageLifecycleData({ ...baseInput, ts: "" });
    const after = Date.now();
    expect(new Date(data.ts).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(data.ts).getTime()).toBeLessThanOrEqual(after + 5);
  });

  test("buildMessageLifecycleFeedEvent handles local identities and invalid timestamp fallback", () => {
    const before = Date.now();
    const event = buildMessageLifecycleFeedEvent({
      ...baseInput,
      ts: "not-a-date",
      from: "solo-oracle",
      to: "receiver",
      target: undefined,
      text: "short text",
    });
    const after = Date.now();
    expect(event.host).toBe("local");
    expect(event.oracle).toBe("solo-oracle");
    expect(event.sessionId).toBe("");
    expect(event.ts).toBeGreaterThanOrEqual(before);
    expect(event.ts).toBeLessThanOrEqual(after + 5);
  });

  test("isMessageLifecycleData accepts complete payloads and rejects malformed values", () => {
    const data = buildMessageLifecycleData(baseInput);
    expect(isMessageLifecycleData(data)).toBe(true);
    expect(isMessageLifecycleData(null)).toBe(false);
    expect(isMessageLifecycleData("nope")).toBe(false);
    expect(isMessageLifecycleData({ ...data, id: 123 })).toBe(false);
    expect(isMessageLifecycleData({ ...data, direction: "sideways" })).toBe(false);
    expect(isMessageLifecycleData({ ...data, state: "lost" })).toBe(false);
    expect(isMessageLifecycleData({ ...data, channel: 7 })).toBe(false);
    expect(isMessageLifecycleData({ ...data, route: 7 })).toBe(false);
    expect(isMessageLifecycleData({ ...data, from: 7 })).toBe(false);
    expect(isMessageLifecycleData({ ...data, to: 7 })).toBe(false);
    expect(isMessageLifecycleData({ ...data, text: 7 })).toBe(false);
  });
});
