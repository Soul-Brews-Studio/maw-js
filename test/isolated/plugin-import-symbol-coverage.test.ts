import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { importPluginSymbol, resetDiscoverCache } from "../../src/plugin/registry";
import type { LoadedPlugin, PluginManifest } from "../../src/plugin/types";

function makePlugin(
  dir: string,
  overrides: Partial<PluginManifest> & { name?: string } = {},
  loaded: Partial<LoadedPlugin> = {},
): LoadedPlugin {
  const manifest: PluginManifest = {
    name: overrides.name ?? "helper",
    version: "1.0.0",
    sdk: "*",
    ...overrides,
  };
  return {
    manifest,
    dir,
    wasmPath: "",
    kind: "ts",
    ...loaded,
  };
}

describe("importPluginSymbol", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "maw-plugin-symbol-"));
    resetDiscoverCache();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    resetDiscoverCache();
  });

  test("returns whitelisted named exports from a plugin module", async () => {
    const dir = join(root, "helper");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "lib.ts"),
      "export const answer = 42; export function greet(name: string) { return `hi ${name}`; }\n",
    );
    const plugin = makePlugin(dir, {
      module: { path: "./lib.ts", exports: ["answer", "greet"] },
    });

    const answer = await importPluginSymbol<number>("helper", "answer", {
      discoverPackages: () => [plugin],
    });
    const greet = await importPluginSymbol<(name: string) => string>("helper", "greet", {
      discoverPackages: () => [plugin],
    });

    expect(answer).toBe(42);
    expect(greet("Nat")).toBe("hi Nat");
  });

  test("rejects missing plugin names and symbols before discovery", async () => {
    await expect(importPluginSymbol("", "thing", { discoverPackages: () => [] })).rejects.toThrow(
      "pluginName is required",
    );
    await expect(importPluginSymbol("helper", "", { discoverPackages: () => [] })).rejects.toThrow(
      "symbolName is required",
    );
  });

  test("rejects absent or disabled plugins", async () => {
    const dir = join(root, "helper");
    mkdirSync(dir);
    const disabled = makePlugin(dir, {
      module: { path: "./lib.ts", exports: ["answer"] },
    }, { disabled: true });

    await expect(importPluginSymbol("missing", "answer", { discoverPackages: () => [] })).rejects.toThrow(
      "plugin 'missing' not found",
    );
    await expect(importPluginSymbol("helper", "answer", { discoverPackages: () => [disabled] })).rejects.toThrow(
      "plugin 'helper' is disabled",
    );
  });

  test("rejects plugins without module surfaces or undeclared symbols", async () => {
    const dir = join(root, "helper");
    mkdirSync(dir);
    const noModule = makePlugin(dir);
    const privateSymbol = makePlugin(dir, {
      module: { path: "./lib.ts", exports: ["publicThing"] },
    });

    await expect(importPluginSymbol("helper", "publicThing", {
      discoverPackages: () => [noModule],
    })).rejects.toThrow("does not declare a module surface");
    await expect(importPluginSymbol("helper", "privateThing", {
      discoverPackages: () => [privateSymbol],
    })).rejects.toThrow("does not export 'privateThing'");
  });

  test("rejects module paths that escape the plugin directory", async () => {
    const dir = join(root, "helper");
    mkdirSync(dir);
    writeFileSync(join(root, "outside.ts"), "export const secret = 7;\n");
    const plugin = makePlugin(dir, {
      module: { path: "../outside.ts", exports: ["secret"] },
    });

    await expect(importPluginSymbol("helper", "secret", {
      discoverPackages: () => [plugin],
    })).rejects.toThrow("module.path escapes plugin dir");
  });

  test("rejects when the runtime module omits an allowlisted export", async () => {
    const dir = join(root, "helper");
    mkdirSync(dir);
    writeFileSync(join(dir, "lib.ts"), "export const other = true;\n");
    const plugin = makePlugin(dir, {
      module: { path: "./lib.ts", exports: ["missing"] },
    });

    await expect(importPluginSymbol("helper", "missing", {
      discoverPackages: () => [plugin],
    })).rejects.toThrow("module did not provide export 'missing'");
  });

  test("caches successful symbol imports until resetDiscoverCache", async () => {
    const dir = join(root, "helper");
    mkdirSync(dir);
    writeFileSync(join(dir, "lib.ts"), "export const stamp = Math.random();\n");
    const plugin = makePlugin(dir, {
      module: { path: "./lib.ts", exports: ["stamp"] },
    });
    let discoverCalls = 0;

    const first = await importPluginSymbol<number>("helper", "stamp", {
      discoverPackages: () => {
        discoverCalls++;
        return [plugin];
      },
    });
    const second = await importPluginSymbol<number>("helper", "stamp", {
      discoverPackages: () => {
        discoverCalls++;
        return [plugin];
      },
    });

    expect(second).toBe(first);
    expect(discoverCalls).toBe(2);
  });
});
