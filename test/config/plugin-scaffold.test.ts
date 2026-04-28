/**
 * Tests for src/commands/shared/plugin-create-scaffold.ts — validatePluginName, buildManifestJson.
 * Pure functions, no I/O.
 */
import { describe, it, expect } from "bun:test";
import { validatePluginName, buildManifestJson } from "../../src/commands/shared/plugin-create-scaffold";

// ─── validatePluginName ──────────────────────────────────────────

describe("validatePluginName", () => {
  it("returns null for valid names", () => {
    expect(validatePluginName("my-plugin")).toBeNull();
    expect(validatePluginName("hello123")).toBeNull();
    expect(validatePluginName("a")).toBeNull();
  });

  it("returns null for names with underscores", () => {
    expect(validatePluginName("my_plugin")).toBeNull();
  });

  it("rejects empty name", () => {
    expect(validatePluginName("")).not.toBeNull();
    expect(validatePluginName("")).toContain("required");
  });

  it("rejects names starting with digit", () => {
    expect(validatePluginName("1plugin")).not.toBeNull();
  });

  it("rejects names starting with hyphen", () => {
    expect(validatePluginName("-plugin")).not.toBeNull();
  });

  it("rejects uppercase letters", () => {
    expect(validatePluginName("MyPlugin")).not.toBeNull();
  });

  it("rejects special characters", () => {
    expect(validatePluginName("my@plugin")).not.toBeNull();
    expect(validatePluginName("my plugin")).not.toBeNull();
  });
});

// ─── buildManifestJson ───────────────────────────────────────────

describe("buildManifestJson", () => {
  it("returns valid JSON", () => {
    const json = buildManifestJson("test-plugin", "rust");
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("sets correct name for rust plugin", () => {
    const manifest = JSON.parse(buildManifestJson("my-plugin", "rust"));
    expect(manifest.name).toBe("my-plugin");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.sdk).toBe("^1.0.0");
  });

  it("slugifies underscores to hyphens in name", () => {
    const manifest = JSON.parse(buildManifestJson("my_plugin", "rust"));
    expect(manifest.name).toBe("my-plugin");
  });

  it("sets rust wasm path with underscored filename", () => {
    const manifest = JSON.parse(buildManifestJson("my-plugin", "rust"));
    expect(manifest.wasm).toContain("my_plugin.wasm");
    expect(manifest.wasm).toContain("wasm32-unknown-unknown");
  });

  it("sets AS wasm path", () => {
    const manifest = JSON.parse(buildManifestJson("my-plugin", "as"));
    expect(manifest.wasm).toBe("./build/release.wasm");
  });

  it("includes cli section with command", () => {
    const manifest = JSON.parse(buildManifestJson("test", "rust"));
    expect(manifest.cli.command).toBe("test");
  });

  it("includes api section with plugin path", () => {
    const manifest = JSON.parse(buildManifestJson("hello", "rust"));
    expect(manifest.api.path).toBe("/api/plugins/hello");
    expect(manifest.api.methods).toContain("GET");
    expect(manifest.api.methods).toContain("POST");
  });

  it("description includes language type", () => {
    const rust = JSON.parse(buildManifestJson("test", "rust"));
    expect(rust.description).toContain("Rust");

    const as = JSON.parse(buildManifestJson("test", "as"));
    expect(as.description).toContain("AssemblyScript");
  });
});
