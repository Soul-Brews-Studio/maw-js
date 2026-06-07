import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { invokePlugin } from "../../src/plugin/registry-invoke";
import type { LoadedPlugin } from "../../src/plugin/types";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const ROOT = new URL("../..", import.meta.url).pathname;
const pluginDir = join(ROOT, "src/vendor/mpr-plugins/pulse");

let calls: Array<[string, ...unknown[]]> = [];
let worktrees: Array<{ status: string; name: string; mainRepo: string; branch: string; path: string }> = [];

function parseFlags(args: string[], spec: Record<string, unknown>) {
  const out: Record<string, any> = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const alias = spec[arg];
    if (alias && typeof alias === "string" && alias.startsWith("--")) {
      out[alias] = args[i + 1];
      i += 1;
    } else if (arg.startsWith("--")) {
      out[arg] = args[i + 1];
      i += 1;
    } else {
      out._.push(arg);
    }
  }
  return out;
}

const sdkMock = {
  parseFlags,
  cmdPulseAdd: async (title: string, opts: unknown) => calls.push(["add", title, opts]),
  cmdPulseLs: async (opts: unknown) => calls.push(["ls", opts]),
  scanWorktrees: async () => worktrees,
  cleanupWorktree: async (path: string) => {
    calls.push(["cleanup", path]);
    return [`removed ${path}`];
  },
};

mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({ ...realSdk, ...sdkMock }));

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name.startsWith(".")) continue;
      out.push(...walkSources(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

function parseImportSpecs(source: string): string[] {
  const specs = new Set<string>();
  const importFrom = /\b(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']/g;
  const importFn = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  const requireFn = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

  for (const re of [importFrom, importFn, requireFn]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specs.add(m[1]);
  }

  return [...specs];
}

function loadPulsePlugin(): LoadedPlugin {
  const loaded = loadManifestFromDir(pluginDir);
  expect(loaded).not.toBeNull();
  return loaded as LoadedPlugin;
}

beforeEach(() => {
  calls = [];
  worktrees = [];
});

describe("pulse plugin standalone boundary (#2283)", () => {
  test("imports runtime dependencies only through the SDK boundary", () => {
    const imports = walkSources(pluginDir).flatMap((file) => parseImportSpecs(readFileSync(file, "utf8")));

    const disallowed = imports.filter((spec) => {
      if (spec.startsWith(".")) return false;
      return spec !== "maw-js/sdk";
    });

    expect(disallowed).toEqual([]);
    expect(imports).toContain("maw-js/sdk");
  });

  test("plugin loads and missing subcommand returns InvokeResult error", async () => {
    const plugin = loadPulsePlugin();

    const result = await invokePlugin(plugin, { source: "cli", args: [] });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("usage: maw pulse <add|ls|cleanup>");
  });

  test("CLI add and ls delegate through SDK helpers", async () => {
    const plugin = loadPulsePlugin();

    await expect(invokePlugin(plugin, {
      source: "cli",
      args: ["add", "ship", "--oracle", "neo", "--priority", "p1", "--worktree", "maw-js"],
    })).resolves.toMatchObject({ ok: true });
    await expect(invokePlugin(plugin, { source: "cli", args: ["ls", "--sync"] })).resolves.toMatchObject({ ok: true });

    expect(calls).toEqual([
      ["add", "ship", { oracle: "neo", priority: "p1", wt: "maw-js" }],
      ["ls", { sync: true }],
    ]);
  });

  test("CLI cleanup uses SDK worktree helpers and supports dry-run", async () => {
    const plugin = loadPulsePlugin();
    worktrees = [
      { status: "active", name: "main", mainRepo: "maw-js", branch: "alpha", path: "/tmp/main" },
      { status: "stale", name: "old", mainRepo: "maw-js", branch: "old", path: "/tmp/old" },
    ];

    const dryRun = await invokePlugin(plugin, { source: "cli", args: ["cleanup", "--dry-run"] });
    expect(dryRun).toMatchObject({ ok: true });
    expect(calls).toEqual([]);

    const clean = await invokePlugin(plugin, { source: "cli", args: ["cleanup"] });
    expect(clean).toMatchObject({ ok: true });
    expect(calls).toEqual([["cleanup", "/tmp/old"]]);
  });
});
