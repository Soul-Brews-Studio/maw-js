/**
 * Tests for validatePluginName, buildManifestJson from
 * src/commands/shared/plugin-create-scaffold.ts.
 * Pure validation + template builder — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { validatePluginName, buildManifestJson } from "../../src/commands/shared/plugin-create-scaffold";

// ─── validatePluginName ─────────────────────────────────────────────────────

describe("validatePluginName", () => {
  it("returns null for valid lowercase name", () => {
    expect(validatePluginName("my-plugin")).toBeNull();
  });

  it("returns null for name with digits", () => {
    expect(validatePluginName("plugin42")).toBeNull();
  });

  it("returns null for name with underscores", () => {
    expect(validatePluginName("my_plugin")).toBeNull();
  });

  it("returns null for name with hyphens and digits", () => {
    expect(validatePluginName("a-b-c-123")).toBeNull();
  });

  it("returns null for single letter", () => {
    expect(validatePluginName("x")).toBeNull();
  });

  it("returns error for empty string", () => {
    expect(validatePluginName("")).toBe("name is required");
  });

  it("returns error for uppercase letters", () => {
    const result = validatePluginName("MyPlugin");
    expect(result).not.toBeNull();
    expect(result).toContain("invalid");
  });

  it("returns error for starting with digit", () => {
    const result = validatePluginName("1plugin");
    expect(result).not.toBeNull();
    expect(result).toContain("invalid");
  });

  it("returns error for starting with hyphen", () => {
    const result = validatePluginName("-plugin");
    expect(result).not.toBeNull();
    expect(result).toContain("invalid");
  });

  it("returns error for starting with underscore", () => {
    const result = validatePluginName("_plugin");
    expect(result).not.toBeNull();
    expect(result).toContain("invalid");
  });

  it("returns error for spaces", () => {
    expect(validatePluginName("my plugin")).not.toBeNull();
  });

  it("returns error for special characters", () => {
    expect(validatePluginName("my.plugin")).not.toBeNull();
    expect(validatePluginName("my@plugin")).not.toBeNull();
    expect(validatePluginName("my/plugin")).not.toBeNull();
  });
});

// ─── buildManifestJson ──────────────────────────────────────────────────────

describe("buildManifestJson", () => {
  it("returns valid JSON string", () => {
    const json = buildManifestJson("hello", "rust");
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("ends with newline", () => {
    expect(buildManifestJson("hello", "rust").endsWith("\n")).toBe(true);
  });

  it("uses hyphen slug for name", () => {
    const manifest = JSON.parse(buildManifestJson("hello_world", "rust"));
    expect(manifest.name).toBe("hello-world");
  });

  it("keeps name without underscores unchanged", () => {
    const manifest = JSON.parse(buildManifestJson("my-plugin", "rust"));
    expect(manifest.name).toBe("my-plugin");
  });

  it("sets version to 0.1.0", () => {
    const manifest = JSON.parse(buildManifestJson("foo", "rust"));
    expect(manifest.version).toBe("0.1.0");
  });

  it("sets rust wasm path with underscored name", () => {
    const manifest = JSON.parse(buildManifestJson("my-plugin", "rust"));
    expect(manifest.wasm).toBe("./target/wasm32-unknown-unknown/release/my_plugin.wasm");
  });

  it("sets AS wasm path to build/release.wasm", () => {
    const manifest = JSON.parse(buildManifestJson("my-plugin", "as"));
    expect(manifest.wasm).toBe("./build/release.wasm");
  });

  it("includes Rust in description for rust lang", () => {
    const manifest = JSON.parse(buildManifestJson("hello", "rust"));
    expect(manifest.description).toContain("Rust");
  });

  it("includes AssemblyScript in description for as lang", () => {
    const manifest = JSON.parse(buildManifestJson("hello", "as"));
    expect(manifest.description).toContain("AssemblyScript");
  });

  it("sets cli command to hyphenated slug", () => {
    const manifest = JSON.parse(buildManifestJson("hello_world", "rust"));
    expect(manifest.cli.command).toBe("hello-world");
  });

  it("sets api path with slug", () => {
    const manifest = JSON.parse(buildManifestJson("hello_world", "rust"));
    expect(manifest.api.path).toBe("/api/plugins/hello-world");
  });

  it("sets api methods to GET and POST", () => {
    const manifest = JSON.parse(buildManifestJson("foo", "rust"));
    expect(manifest.api.methods).toEqual(["GET", "POST"]);
  });

  it("sets sdk version", () => {
    const manifest = JSON.parse(buildManifestJson("foo", "rust"));
    expect(manifest.sdk).toBe("^1.0.0");
  });
});
