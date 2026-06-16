import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  validatePluginName,
  scaffoldRust,
  scaffoldAs,
  copyTree,
  buildManifestJson,
} from "../src/commands/shared/plugin-create";
import { parseManifest } from "../src/plugin/manifest";
import { isUserError } from "../src/core/util/user-error";

// ─── Temp dir management ─────────────────────────────────────────────────────

const created: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "maw-pc-"));
  created.push(d);
  return d;
}

afterEach(() => {
  for (const d of created.splice(0)) {
    try {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    } catch {
      // Best-effort: one leaked dir shouldn't block sibling cleanup.
    }
  }
});

// ─── validatePluginName ──────────────────────────────────────────────────────

describe("validatePluginName", () => {
  test("accepts simple lowercase name", () => {
    expect(validatePluginName("hello")).toBeNull();
  });

  test("accepts name with hyphens and digits", () => {
    expect(validatePluginName("my-plugin-2")).toBeNull();
  });

  test("accepts name with underscores", () => {
    expect(validatePluginName("my_plugin")).toBeNull();
  });

  test("rejects empty string", () => {
    expect(validatePluginName("")).not.toBeNull();
  });

  test("rejects name starting with digit", () => {
    expect(validatePluginName("2plugin")).not.toBeNull();
  });

  test("rejects name with uppercase letters", () => {
    expect(validatePluginName("MyPlugin")).not.toBeNull();
  });

  test("rejects name with spaces", () => {
    expect(validatePluginName("my plugin")).not.toBeNull();
  });
});

// ─── copyTree ────────────────────────────────────────────────────────────────

describe("copyTree", () => {
  test("copies files preserving structure", () => {
    const src = tmpDir();
    const dest = join(tmpDir(), "copy");

    writeFileSync(join(src, "a.txt"), "hello");
    mkdirSync(join(src, "sub"));
    writeFileSync(join(src, "sub", "b.txt"), "world");

    copyTree(src, dest);

    expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("hello");
    expect(readFileSync(join(dest, "sub", "b.txt"), "utf8")).toBe("world");
  });

  test("skips target/ directory", () => {
    const src = tmpDir();
    const dest = join(tmpDir(), "copy");

    writeFileSync(join(src, "keep.txt"), "yes");
    mkdirSync(join(src, "target"));
    writeFileSync(join(src, "target", "artifact.wasm"), "binary");

    copyTree(src, dest);

    expect(existsSync(join(dest, "keep.txt"))).toBe(true);
    expect(existsSync(join(dest, "target"))).toBe(false);
  });
});

// ─── scaffoldRust ────────────────────────────────────────────────────────────

describe("scaffoldRust", () => {
  /** Build a minimal fake hello-rust template directory */
  function makeRustTemplate(dir: string, sdkRelPath = "../../maw-plugin-sdk"): void {
    writeFileSync(
      join(dir, "Cargo.toml"),
      `[package]\nname = "hello-rust"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\ncrate-type = ["cdylib"]\n\n[dependencies]\nmaw-plugin-sdk = { path = "${sdkRelPath}" }\n`,
    );
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "lib.rs"),
      `use maw_plugin_sdk as maw;\n\n#[no_mangle]\npub extern "C" fn handle(ptr: *const u8, len: usize) -> i32 { 0 }\n`,
    );
  }

  test("creates destination directory", () => {
    const template = tmpDir();
    makeRustTemplate(template);
    const dest = join(tmpDir(), "my-plugin");

    scaffoldRust("my-plugin", dest, template, "/fake/sdk");

    expect(existsSync(dest)).toBe(true);
  });

  test("rewrites Cargo.toml package name", () => {
    const template = tmpDir();
    makeRustTemplate(template);
    const dest = join(tmpDir(), "my-plugin");

    scaffoldRust("my-plugin", dest, template, "/fake/sdk");

    const cargo = readFileSync(join(dest, "Cargo.toml"), "utf8");
    expect(cargo).toContain('name = "my-plugin"');
    expect(cargo).not.toContain('name = "hello-rust"');
  });

  test("replaces relative SDK path with provided absolute path", () => {
    const template = tmpDir();
    makeRustTemplate(template);
    const dest = join(tmpDir(), "my-plugin");
    const sdkAbs = "/home/user/.bun/install/global/node_modules/maw/src/wasm/maw-plugin-sdk";

    scaffoldRust("my-plugin", dest, template, sdkAbs);

    const cargo = readFileSync(join(dest, "Cargo.toml"), "utf8");
    expect(cargo).toContain(`path = "${sdkAbs}"`);
    expect(cargo).not.toContain("../../maw-plugin-sdk");
  });

  test("writes README.md at destination", () => {
    const template = tmpDir();
    makeRustTemplate(template);
    const dest = join(tmpDir(), "my-plugin");

    scaffoldRust("my-plugin", dest, template, "/fake/sdk");

    expect(existsSync(join(dest, "README.md"))).toBe(true);
    const readme = readFileSync(join(dest, "README.md"), "utf8");
    expect(readme).toContain("my-plugin");
    expect(readme).toContain("maw plugin install");
  });

  test("copies src/lib.rs from template", () => {
    const template = tmpDir();
    makeRustTemplate(template);
    const dest = join(tmpDir(), "my-plugin");

    scaffoldRust("my-plugin", dest, template, "/fake/sdk");

    expect(existsSync(join(dest, "src", "lib.rs"))).toBe(true);
  });

  test("throws if template directory does not exist", () => {
    const dest = join(tmpDir(), "my-plugin");
    expect(() => scaffoldRust("my-plugin", dest, "/nonexistent/template", "/fake/sdk")).toThrow();
  });
});

// ─── scaffoldAs ──────────────────────────────────────────────────────────────

describe("scaffoldAs", () => {
  /** Build a minimal fake hello-as template directory */
  function makeAsTemplate(dir: string): void {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "hello-as", version: "0.1.0", scripts: { build: "asc assembly/index.ts -o build/hello-as.wasm" } }, null, 2) + "\n",
    );
    mkdirSync(join(dir, "assembly"), { recursive: true });
    writeFileSync(
      join(dir, "assembly", "index.ts"),
      `// AssemblyScript stub\nexport function handle(ptr: i32, len: i32): i32 { return 0; }\nexport const memory = new Memory();\n`,
    );
  }

  test("creates destination directory", () => {
    const template = tmpDir();
    makeAsTemplate(template);
    const dest = join(tmpDir(), "my-as-plugin");

    scaffoldAs("my-as-plugin", dest, template);

    expect(existsSync(dest)).toBe(true);
  });

  test("rewrites package.json name", () => {
    const template = tmpDir();
    makeAsTemplate(template);
    const dest = join(tmpDir(), "my-as-plugin");

    scaffoldAs("my-as-plugin", dest, template);

    const pkg = JSON.parse(readFileSync(join(dest, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-as-plugin");
  });

  test("writes README.md at destination", () => {
    const template = tmpDir();
    makeAsTemplate(template);
    const dest = join(tmpDir(), "my-as-plugin");

    scaffoldAs("my-as-plugin", dest, template);

    expect(existsSync(join(dest, "README.md"))).toBe(true);
    const readme = readFileSync(join(dest, "README.md"), "utf8");
    expect(readme).toContain("my-as-plugin");
    expect(readme).toContain("maw plugin install");
  });

  test("throws if template directory does not exist", () => {
    const dest = join(tmpDir(), "my-as-plugin");
    expect(() => scaffoldAs("my-as-plugin", dest, "/nonexistent/as-template")).toThrow();
  });
});

// ─── plugin.json manifest emission ───────────────────────────────────────────

describe("plugin.json manifest emission", () => {
  function makeRustTpl(dir: string): void {
    writeFileSync(
      join(dir, "Cargo.toml"),
      `[package]\nname = "hello-rust"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\ncrate-type = ["cdylib"]\n\n[dependencies]\nmaw-plugin-sdk = { path = "../../maw-plugin-sdk" }\n`,
    );
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "lib.rs"), `// stub`);
  }

  function makeAsTpl(dir: string): void {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "hello-as", version: "0.1.0" }, null, 2) + "\n",
    );
    mkdirSync(join(dir, "assembly"), { recursive: true });
    writeFileSync(join(dir, "assembly", "index.ts"), `// stub`);
  }

  test("scaffoldRust writes plugin.json that parseManifest validates", () => {
    const template = tmpDir();
    makeRustTpl(template);
    const dest = join(tmpDir(), "my-rust-plugin");

    scaffoldRust("my-rust-plugin", dest, template, "/fake/sdk");

    // parseManifest requires wasm file on disk — create dummy
    const wasmDir = join(dest, "target", "wasm32-unknown-unknown", "release");
    mkdirSync(wasmDir, { recursive: true });
    writeFileSync(join(wasmDir, "my_rust_plugin.wasm"), "fake");

    const manifestText = readFileSync(join(dest, "plugin.json"), "utf8");
    const m = parseManifest(manifestText, dest);

    expect(m.name).toBe("my-rust-plugin");
    expect(m.version).toBe("0.1.0");
    expect(m.sdk).toBe("^1.0.0");
    expect(m.wasm).toBe("./target/wasm32-unknown-unknown/release/my_rust_plugin.wasm");
    expect(m.cli?.command).toBe("my-rust-plugin");
    expect(m.api?.path).toBe("/api/plugins/my-rust-plugin");
  });

  test("scaffoldAs writes plugin.json that parseManifest validates", () => {
    const template = tmpDir();
    makeAsTpl(template);
    const dest = join(tmpDir(), "my-as-plugin");

    scaffoldAs("my-as-plugin", dest, template);

    // parseManifest requires wasm file on disk — create dummy
    const buildDir = join(dest, "build");
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(buildDir, "release.wasm"), "fake");

    const manifestText = readFileSync(join(dest, "plugin.json"), "utf8");
    const m = parseManifest(manifestText, dest);

    expect(m.name).toBe("my-as-plugin");
    expect(m.version).toBe("0.1.0");
    expect(m.sdk).toBe("^1.0.0");
    expect(m.wasm).toBe("./build/release.wasm");
    expect(m.cli?.command).toBe("my-as-plugin");
    expect(m.api?.path).toBe("/api/plugins/my-as-plugin");
  });

  test("buildManifestJson normalizes underscores to hyphens in slug fields", () => {
    const json = buildManifestJson("my_plugin", "rust");
    const data = JSON.parse(json);

    expect(data.name).toBe("my-plugin");          // slug uses hyphens
    expect(data.wasm).toContain("my_plugin.wasm"); // wasm crate name uses underscores
    expect(data.cli.command).toBe("my-plugin");
    expect(data.api.path).toBe("/api/plugins/my-plugin");
    expect(data.api.methods).toEqual(["GET", "POST"]);
  });
});

// ─── scaffoldRust — existing destination ─────────────────────────────────────

describe("scaffoldRust — destination guard (via cmdPluginCreate)", () => {
  test("rejects existing destination with UserError", async () => {
    // We exercise the check in cmdPluginCreate by pointing --dest at an existing dir.
    const existing = tmpDir();

    let thrown: unknown;
    const { cmdPluginCreate } = await import("../src/commands/shared/plugin-create");
    try {
      await cmdPluginCreate("my-plugin", {
        "--rust": true,
        "--dest": existing,
      });
    } catch (err) {
      thrown = err;
    }

    expect(isUserError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain("Destination already exists");
  });
});
