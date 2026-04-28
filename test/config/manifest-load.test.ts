/**
 * Tests for src/plugin/manifest-load.ts — loadManifestFromDir with real temp dirs.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadManifestFromDir } from "../../src/plugin/manifest-load";

describe("loadManifestFromDir", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `maw-test-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when no plugin.json exists", () => {
    expect(loadManifestFromDir(tmp)).toBeNull();
  });

  function writeEntry(name: string): void {
    writeFileSync(join(tmp, name), "// entry");
  }

  function writeWasm(name: string): void {
    // Minimal WASM magic bytes
    writeFileSync(join(tmp, name), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  }

  it("loads valid plugin.json with entry", () => {
    writeEntry("index.ts");
    const manifest = {
      name: "test-plugin",
      version: "1.0.0",
      sdk: "^0.1.0",
      description: "A test plugin",
      entry: "./index.ts",
    };
    writeFileSync(join(tmp, "plugin.json"), JSON.stringify(manifest));
    const result = loadManifestFromDir(tmp);
    expect(result).not.toBeNull();
    expect(result!.manifest.name).toBe("test-plugin");
    expect(result!.manifest.version).toBe("1.0.0");
  });

  it("sets dir to provided directory", () => {
    writeEntry("index.ts");
    const manifest = {
      name: "test-plugin",
      version: "1.0.0",
      sdk: "^0.1.0",
      entry: "./index.ts",
    };
    writeFileSync(join(tmp, "plugin.json"), JSON.stringify(manifest));
    const result = loadManifestFromDir(tmp);
    expect(result!.dir).toBe(tmp);
  });

  it("resolves kind to ts when entry is present", () => {
    writeEntry("index.ts");
    const manifest = {
      name: "ts-plugin",
      version: "1.0.0",
      sdk: "^0.1.0",
      entry: "./index.ts",
    };
    writeFileSync(join(tmp, "plugin.json"), JSON.stringify(manifest));
    const result = loadManifestFromDir(tmp);
    expect(result!.kind).toBe("ts");
  });

  it("resolves kind to wasm when only wasm is present", () => {
    writeWasm("plugin.wasm");
    const manifest = {
      name: "wasm-plugin",
      version: "1.0.0",
      sdk: "^0.1.0",
      wasm: "./plugin.wasm",
    };
    writeFileSync(join(tmp, "plugin.json"), JSON.stringify(manifest));
    const result = loadManifestFromDir(tmp);
    expect(result!.kind).toBe("wasm");
  });

  it("resolves wasmPath when wasm field present", () => {
    writeWasm("plugin.wasm");
    const manifest = {
      name: "wasm-plugin",
      version: "1.0.0",
      sdk: "^0.1.0",
      wasm: "./plugin.wasm",
    };
    writeFileSync(join(tmp, "plugin.json"), JSON.stringify(manifest));
    const result = loadManifestFromDir(tmp);
    expect(result!.wasmPath).toBe(join(tmp, "plugin.wasm"));
  });

  it("resolves entryPath when entry field present", () => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src/main.ts"), "// entry");
    const manifest = {
      name: "ts-plugin",
      version: "1.0.0",
      sdk: "^0.1.0",
      entry: "./src/main.ts",
    };
    writeFileSync(join(tmp, "plugin.json"), JSON.stringify(manifest));
    const result = loadManifestFromDir(tmp);
    expect(result!.entryPath).toBe(join(tmp, "src/main.ts"));
  });

  it("handles artifact.path as fallback entry for js target", () => {
    writeEntry("index.js");
    const manifest = {
      name: "built-plugin",
      version: "1.0.0",
      sdk: "^0.1.0",
      target: "js",
      artifact: { path: "./index.js", sha256: "abc123" },
    };
    writeFileSync(join(tmp, "plugin.json"), JSON.stringify(manifest));
    const result = loadManifestFromDir(tmp);
    expect(result!.kind).toBe("ts");
    expect(result!.entryPath).toBe(join(tmp, "index.js"));
  });

  it("entry takes precedence over artifact.path", () => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src/main.ts"), "// entry");
    const manifest = {
      name: "dual-plugin",
      version: "1.0.0",
      sdk: "^0.1.0",
      entry: "./src/main.ts",
      target: "js",
      artifact: { path: "./index.js", sha256: "abc123" },
    };
    writeFileSync(join(tmp, "plugin.json"), JSON.stringify(manifest));
    const result = loadManifestFromDir(tmp);
    expect(result!.entryPath).toBe(join(tmp, "src/main.ts"));
  });

  it("throws on invalid JSON", () => {
    writeFileSync(join(tmp, "plugin.json"), "not json");
    expect(() => loadManifestFromDir(tmp)).toThrow();
  });

  it("preserves description field", () => {
    writeEntry("index.ts");
    const manifest = {
      name: "desc-plugin",
      version: "1.0.0",
      sdk: "^0.1.0",
      description: "Does cool things",
      entry: "./index.ts",
    };
    writeFileSync(join(tmp, "plugin.json"), JSON.stringify(manifest));
    const result = loadManifestFromDir(tmp);
    expect(result!.manifest.description).toBe("Does cool things");
  });
});
