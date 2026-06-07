import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const originalEnv = { ...process.env };
const mod = await import("../../src/commands/shared/plugin-create-scaffold.ts?plugin-create-scaffold-more-coverage");

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("plugin-create scaffold helpers more coverage", () => {
  test("defaultRustSdkPath honors explicit override before filesystem probing", () => {
    process.env.MAW_SDK_RUST_PATH = "/custom/sdk";
    expect(mod.defaultRustSdkPath()).toBe("/custom/sdk");
  });

  test("validatePluginName covers required, invalid, and valid names", () => {
    expect(mod.validatePluginName("")).toBe("name is required");
    expect(mod.validatePluginName("BadName")).toContain("invalid");
    expect(mod.validatePluginName("plugin_1-ok")).toBeNull();
  });

  test("copyTree recursively copies files while skipping build and VCS artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "maw-copy-tree-"));
    const src = join(root, "src");
    const dest = join(root, "dest");
    mkdirSync(join(src, "nested"), { recursive: true });
    mkdirSync(join(src, "target"), { recursive: true });
    mkdirSync(join(src, ".git"), { recursive: true });
    mkdirSync(join(src, "node_modules"), { recursive: true });
    writeFileSync(join(src, "root.txt"), "root");
    writeFileSync(join(src, "nested", "child.txt"), "child");
    writeFileSync(join(src, "target", "skip.txt"), "skip");
    writeFileSync(join(src, ".git", "skip.txt"), "skip");
    writeFileSync(join(src, "node_modules", "skip.txt"), "skip");

    mod.copyTree(src, dest);

    expect(readFileSync(join(dest, "root.txt"), "utf8")).toBe("root");
    expect(readFileSync(join(dest, "nested", "child.txt"), "utf8")).toBe("child");
    expect(existsSync(join(dest, "target"))).toBe(false);
    expect(existsSync(join(dest, ".git"))).toBe(false);
    expect(existsSync(join(dest, "node_modules"))).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  test("buildManifestJson slugifies names and chooses language-specific wasm paths", () => {
    const rust = JSON.parse(mod.buildManifestJson("my_plugin", "rust"));
    expect(rust.name).toBe("my-plugin");
    expect(rust.wasm).toBe("./target/wasm32-unknown-unknown/release/my_plugin.wasm");
    expect(rust.description).toBe("Rust plugin: my_plugin");
    expect(rust.cli.command).toBe("my-plugin");

    const as = JSON.parse(mod.buildManifestJson("as-plugin", "as"));
    expect(as.name).toBe("as-plugin");
    expect(as.wasm).toBe("./build/release.wasm");
    expect(as.description).toBe("AssemblyScript plugin: as-plugin");
  });
});
