/**
 * Tests for src/transports/lora.ts — LoRaTransport stub.
 * Pure class: no external dependencies.
 */
import { describe, it, expect } from "bun:test";
import { LoRaTransport } from "../../src/transports/lora";

describe("LoRaTransport", () => {
  it("has name 'lora'", () => {
    const t = new LoRaTransport();
    expect(t.name).toBe("lora");
  });

  it("starts disconnected", () => {
    const t = new LoRaTransport();
    expect(t.connected).toBe(false);
  });

  it("connect does not change connected state (stub)", async () => {
    const t = new LoRaTransport();
    await t.connect();
    expect(t.connected).toBe(false);
  });

  it("disconnect sets connected to false", async () => {
    const t = new LoRaTransport();
    await t.disconnect();
    expect(t.connected).toBe(false);
  });

  it("send always returns false", async () => {
    const t = new LoRaTransport();
    const result = await t.send({ oracle: "test", host: "local" }, "hello");
    expect(result).toBe(false);
  });

  it("canReach always returns false", () => {
    const t = new LoRaTransport();
    expect(t.canReach({ oracle: "any", host: "any" })).toBe(false);
  });

  it("onMessage registers handler without throwing", () => {
    const t = new LoRaTransport();
    expect(() => t.onMessage(() => {})).not.toThrow();
  });

  it("onPresence registers handler without throwing", () => {
    const t = new LoRaTransport();
    expect(() => t.onPresence(() => {})).not.toThrow();
  });

  it("onFeed registers handler without throwing", () => {
    const t = new LoRaTransport();
    expect(() => t.onFeed(() => {})).not.toThrow();
  });

  it("publishPresence does not throw", async () => {
    const t = new LoRaTransport();
    await expect(t.publishPresence({ oracle: "x", host: "h", status: "idle", timestamp: 0 })).resolves.toBeUndefined();
  });

  it("publishFeed does not throw", async () => {
    const t = new LoRaTransport();
    await expect(t.publishFeed({} as any)).resolves.toBeUndefined();
  });
});
