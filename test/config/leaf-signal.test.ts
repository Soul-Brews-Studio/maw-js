/**
 * Tests for writeSignal from src/core/fleet/leaf.ts.
 * Uses real temp dirs — no mocking needed.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeSignal } from "../../src/core/fleet/leaf";

let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `maw-test-leaf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("writeSignal", () => {
  it("creates signal file in ψ/memory/signals/", () => {
    const path = writeSignal(tmp, "child", { kind: "info", message: "hello world" });
    expect(existsSync(path)).toBe(true);
    expect(path).toContain(join("ψ", "memory", "signals"));
  });

  it("writes valid JSON with correct shape", () => {
    const path = writeSignal(tmp, "child", { kind: "alert", message: "something broke" });
    const signal = JSON.parse(readFileSync(path, "utf-8"));
    expect(signal.bud).toBe("child");
    expect(signal.kind).toBe("alert");
    expect(signal.message).toBe("something broke");
    expect(signal.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("includes context when provided", () => {
    const path = writeSignal(tmp, "child", {
      kind: "pattern",
      message: "found pattern",
      context: { key: "value", count: 42 },
    });
    const signal = JSON.parse(readFileSync(path, "utf-8"));
    expect(signal.context).toEqual({ key: "value", count: 42 });
  });

  it("excludes context key when not provided", () => {
    const path = writeSignal(tmp, "child", { kind: "info", message: "no ctx" });
    const signal = JSON.parse(readFileSync(path, "utf-8"));
    expect("context" in signal).toBe(false);
  });

  it("creates directories recursively", () => {
    const nested = join(tmp, "deep", "nested");
    // writeSignal creates ψ/memory/signals/ inside parentRoot
    const path = writeSignal(nested, "bud", { kind: "info", message: "test" });
    expect(existsSync(path)).toBe(true);
  });

  it("filename contains date, bud name, and slug", () => {
    const path = writeSignal(tmp, "neo", { kind: "info", message: "Hello World!" });
    const filename = path.split("/").pop()!;
    // Should contain date (YYYY-MM-DD), bud name, and slugified message
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}_neo_hello-world\.json$/);
  });

  it("slugifies special characters in message", () => {
    const path = writeSignal(tmp, "bud", { kind: "info", message: "TEST@#$%^&*()!!!" });
    const filename = path.split("/").pop()!;
    expect(filename).toContain("_bud_");
    expect(filename).toEndWith(".json");
    // Should not contain special chars in slug
    expect(filename).not.toMatch(/[@#$%^&*()!]/);
  });

  it("truncates long messages in filename slug to 32 chars", () => {
    const longMsg = "a".repeat(100);
    const path = writeSignal(tmp, "bud", { kind: "info", message: longMsg });
    const filename = path.split("/").pop()!;
    // Slug portion should be at most 32 chars
    const parts = filename.replace(".json", "").split("_");
    const slug = parts.slice(2).join("_");
    expect(slug.length).toBeLessThanOrEqual(32);
  });

  it("uses kind as slug when message produces empty slug", () => {
    const path = writeSignal(tmp, "bud", { kind: "alert", message: "   " });
    const filename = path.split("/").pop()!;
    expect(filename).toContain("_alert.json");
  });
});
