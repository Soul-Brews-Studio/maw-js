/**
 * Tests for definePlugin from src/sdk/index.ts — pure validation function.
 */
import { describe, it, expect } from "bun:test";
import { definePlugin } from "../../src/sdk/index";

const handler = async () => ({ ok: true as const, output: "hello" });

describe("definePlugin", () => {
  it("returns config unchanged for valid input", () => {
    const config = { name: "my-plugin", handler };
    const result = definePlugin(config);
    expect(result).toBe(config);
  });

  it("throws when name is empty", () => {
    expect(() => definePlugin({ name: "", handler })).toThrow("name is required");
  });

  it("throws when name is missing (undefined coercion)", () => {
    expect(() => definePlugin({ name: undefined as any, handler })).toThrow("name is required");
  });

  it("throws when handler is missing", () => {
    expect(() => definePlugin({ name: "x", handler: undefined as any })).toThrow("handler is required");
  });

  it("throws when handler is not a function", () => {
    expect(() => definePlugin({ name: "x", handler: "nope" as any })).toThrow("handler is required");
  });

  it("preserves optional lifecycle hooks", () => {
    const onGate = () => true;
    const onFilter = (e: any) => e;
    const onEvent = async () => {};
    const onLate = () => {};
    const onInstall = async () => {};
    const onUninstall = async () => {};
    const config = { name: "test", handler, onGate, onFilter, onEvent, onLate, onInstall, onUninstall };
    const result = definePlugin(config);
    expect(result.onGate).toBe(onGate);
    expect(result.onFilter).toBe(onFilter);
    expect(result.onEvent).toBe(onEvent);
    expect(result.onLate).toBe(onLate);
    expect(result.onInstall).toBe(onInstall);
    expect(result.onUninstall).toBe(onUninstall);
  });

  it("accepts minimal config (name + handler only)", () => {
    const result = definePlugin({ name: "minimal", handler });
    expect(result.name).toBe("minimal");
    expect(typeof result.handler).toBe("function");
    expect(result.onGate).toBeUndefined();
  });
});
