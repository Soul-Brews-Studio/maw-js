/**
 * Tests for src/plugin/manifest-parse.ts — parseManifest.
 * Tests the required-field validation layer.
 * Uses artifact-only manifests to avoid existsSync checks for wasm/entry.
 */
import { describe, it, expect } from "bun:test";
import { parseManifest } from "../../src/plugin/manifest-parse";

const validBase = {
  name: "test-plugin",
  version: "1.0.0",
  sdk: "^1.0.0",
  artifact: { path: "./dist/index.js", sha256: null },
};

function json(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...validBase, ...overrides });
}

describe("parseManifest", () => {
  it("parses valid manifest", () => {
    const result = parseManifest(json(), "/tmp");
    expect(result.name).toBe("test-plugin");
    expect(result.version).toBe("1.0.0");
    expect(result.sdk).toBe("^1.0.0");
  });

  it("throws for invalid JSON", () => {
    expect(() => parseManifest("{invalid", "/tmp")).toThrow("invalid JSON");
  });

  it("throws for array input", () => {
    expect(() => parseManifest("[]", "/tmp")).toThrow("must be a JSON object");
  });

  it("throws for invalid name (uppercase)", () => {
    expect(() => parseManifest(json({ name: "MyPlugin" }), "/tmp")).toThrow("name must match");
  });

  it("throws for invalid name (spaces)", () => {
    expect(() => parseManifest(json({ name: "my plugin" }), "/tmp")).toThrow("name must match");
  });

  it("throws for invalid version (not semver)", () => {
    expect(() => parseManifest(json({ version: "latest" }), "/tmp")).toThrow("version must be semver");
  });

  it("throws for missing entry/wasm/artifact", () => {
    const noEntry = { name: "test", version: "1.0.0", sdk: "^1.0.0" };
    expect(() => parseManifest(JSON.stringify(noEntry), "/tmp")).toThrow("must have");
  });

  it("throws for invalid sdk range", () => {
    expect(() => parseManifest(json({ sdk: "latest" }), "/tmp")).toThrow("sdk must be a semver range");
  });

  it("throws for invalid weight (>99)", () => {
    expect(() => parseManifest(json({ weight: 100 }), "/tmp")).toThrow("weight must be a number 0-99");
  });

  it("throws for negative weight", () => {
    expect(() => parseManifest(json({ weight: -1 }), "/tmp")).toThrow("weight must be a number 0-99");
  });

  it("accepts valid weight", () => {
    const result = parseManifest(json({ weight: 50 }), "/tmp");
    expect(result.weight).toBe(50);
  });

  it("includes optional description", () => {
    const result = parseManifest(json({ description: "A test plugin" }), "/tmp");
    expect(result.description).toBe("A test plugin");
  });

  it("includes optional author", () => {
    const result = parseManifest(json({ author: "Boom" }), "/tmp");
    expect(result.author).toBe("Boom");
  });

  it("parses cli section", () => {
    const result = parseManifest(json({ cli: { command: "test" } }), "/tmp");
    expect(result.cli?.command).toBe("test");
  });
});
