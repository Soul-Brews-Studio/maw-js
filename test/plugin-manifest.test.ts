import { describe, test, expect } from "bun:test";
import { parseManifest, loadManifestFromDir } from "../src/plugin/manifest";
import { discoverPackages, invokePlugin } from "../src/plugin/registry";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Minimal WASM: exports handle(i32,i32)->i32 + memory. No imports. Returns 0.
// ---------------------------------------------------------------------------
const MINIMAL_WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, // magic
  0x01, 0x00, 0x00, 0x00, // version 1
  // Type section: (i32, i32) -> i32
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  // Function section: 1 function using type 0
  0x03, 0x02, 0x01, 0x00,
  // Memory section: min 1 page
  0x05, 0x03, 0x01, 0x00, 0x01,
  // Export section: "memory" (memory 0) + "handle" (func 0)
  0x07, 0x13, 0x02,
  0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
  0x06, 0x68, 0x61, 0x6e, 0x64, 0x6c, 0x65, 0x00, 0x00,
  // Code section: i32.const 0
  0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x00, 0x0b,
]);

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "maw-manifest-test-"));
}

// ---------------------------------------------------------------------------
// parseManifest — happy path
// ---------------------------------------------------------------------------

describe("parseManifest happy path", () => {
  test("parses minimal valid manifest", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      const manifest = parseManifest(
        JSON.stringify({ name: "hello-plugin", version: "1.0.0", wasm: "plugin.wasm", sdk: "^1.0.0" }),
        dir,
      );
      expect(manifest.name).toBe("hello-plugin");
      expect(manifest.version).toBe("1.0.0");
      expect(manifest.wasm).toBe("plugin.wasm");
      expect(manifest.sdk).toBe("^1.0.0");
      expect(manifest.cli).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("parses optional cli, api, description, author", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      const manifest = parseManifest(
        JSON.stringify({
          name: "full-plugin",
          version: "2.3.4",
          wasm: "plugin.wasm",
          sdk: "~1.2.0",
          cli: { command: "greet", help: "Say hello" },
          api: { path: "/greet", methods: ["GET", "POST"] },
          description: "A greeting plugin",
          author: "Nat",
        }),
        dir,
      );
      expect(manifest.cli?.command).toBe("greet");
      expect(manifest.cli?.help).toBe("Say hello");
      expect(manifest.api?.path).toBe("/greet");
      expect(manifest.api?.methods).toEqual(["GET", "POST"]);
      expect(manifest.description).toBe("A greeting plugin");
      expect(manifest.author).toBe("Nat");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("accepts * as sdk range", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      const m = parseManifest(
        JSON.stringify({ name: "any-sdk", version: "0.0.1", wasm: "plugin.wasm", sdk: "*" }),
        dir,
      );
      expect(m.sdk).toBe("*");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// parseManifest — validation failures
// ---------------------------------------------------------------------------

describe("parseManifest validation failures", () => {
  test("throws on invalid JSON", () => {
    expect(() => parseManifest("not json!", "/tmp")).toThrow(/JSON/);
  });

  test("throws on invalid name (uppercase, special chars)", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      expect(() =>
        parseManifest(
          JSON.stringify({ name: "Hello_Plugin!", version: "1.0.0", wasm: "plugin.wasm", sdk: "*" }),
          dir,
        ),
      ).toThrow(/name/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("throws on invalid semver version", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      expect(() =>
        parseManifest(
          JSON.stringify({ name: "my-plugin", version: "not-semver", wasm: "plugin.wasm", sdk: "*" }),
          dir,
        ),
      ).toThrow(/version/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("throws when wasm file does not exist on disk", () => {
    const dir = makeTempDir();
    try {
      expect(() =>
        parseManifest(
          JSON.stringify({ name: "my-plugin", version: "1.0.0", wasm: "missing.wasm", sdk: "*" }),
          dir,
        ),
      ).toThrow(/wasm/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("throws on invalid sdk range", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      expect(() =>
        parseManifest(
          JSON.stringify({ name: "my-plugin", version: "1.0.0", wasm: "plugin.wasm", sdk: "not-a-range" }),
          dir,
        ),
      ).toThrow(/sdk/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// loadManifestFromDir
// ---------------------------------------------------------------------------

describe("loadManifestFromDir", () => {
  test("returns null when no plugin.json in dir", () => {
    const dir = makeTempDir();
    try {
      expect(loadManifestFromDir(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("returns LoadedPlugin with resolved absolute wasmPath", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      writeFileSync(
        join(dir, "plugin.json"),
        JSON.stringify({ name: "test-pkg", version: "1.0.0", wasm: "plugin.wasm", sdk: "*" }),
      );
      const loaded = loadManifestFromDir(dir);
      expect(loaded).not.toBeNull();
      expect(loaded!.manifest.name).toBe("test-pkg");
      expect(loaded!.wasmPath).toBe(join(dir, "plugin.wasm"));
      expect(loaded!.dir).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// discoverPackages
// ---------------------------------------------------------------------------

describe("discoverPackages", () => {
  test("returns an array without throwing (dirs may not exist)", () => {
    const packages = discoverPackages();
    expect(Array.isArray(packages)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// invokePlugin
// ---------------------------------------------------------------------------

describe("invokePlugin", () => {
  test("returns ok:true for minimal wasm (handle returns 0)", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      const result = await invokePlugin(
        {
          manifest: { name: "test-invoke", version: "1.0.0", wasm: "plugin.wasm", sdk: "*" },
          dir,
          wasmPath: join(dir, "plugin.wasm"),
        },
        { source: "cli", args: ["hello"] },
      );
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("returns ok:false for missing wasm file", async () => {
    const result = await invokePlugin(
      {
        manifest: { name: "missing", version: "1.0.0", wasm: "missing.wasm", sdk: "*" },
        dir: "/tmp",
        wasmPath: "/tmp/this-file-does-not-exist-xyzzy-maw.wasm",
      },
      { source: "api", args: {} },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("accepts InvokeContext with object args (api source)", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "plugin.wasm"), MINIMAL_WASM);
      const result = await invokePlugin(
        {
          manifest: { name: "api-invoke", version: "1.0.0", wasm: "plugin.wasm", sdk: "*" },
          dir,
          wasmPath: join(dir, "plugin.wasm"),
        },
        { source: "api", args: { input: "test", count: 3 } },
      );
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
