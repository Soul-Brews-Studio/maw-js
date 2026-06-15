import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { invokePlugin } from "../../src/plugin/registry-invoke";
import type { LoadedPlugin } from "../../src/plugin/types";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const ROOT = new URL("../..", import.meta.url).pathname;
const pluginDir = join(ROOT, "src/vendor/mpr-plugins/scope");
let configDir = "";

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  mawConfigDir: () => configDir,
}));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({
  ...realSdk,
  mawConfigDir: () => configDir,
}));

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

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function loadScopePlugin(): LoadedPlugin {
  const loaded = loadManifestFromDir(pluginDir);
  expect(loaded).not.toBeNull();
  return loaded as LoadedPlugin;
}

beforeEach(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  configDir = mkdtempSync(join(tmpdir(), "maw-scope-standalone-"));
});

describe("scope plugin standalone boundary", () => {
  test("imports runtime dependencies only through the SDK boundary", () => {
    const imports = walkSources(pluginDir).flatMap((file) => parseImportSpecs(readFileSync(file, "utf8")));

    const disallowed = imports.filter((spec) => {
      if (spec.startsWith(".")) return false;
      if (["fs", "path"].includes(spec)) return false;
      return spec !== "maw-js/sdk";
    });

    expect(disallowed).toEqual([]);
    expect(imports).toContain("maw-js/sdk");
  });

  test("plugin loads and help returns InvokeResult", async () => {
    const plugin = loadScopePlugin();

    const result = await invokePlugin(plugin, { source: "cli", args: [] });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("usage: maw scope");
  });

  test("create, list, show, and delete run with only SDK path mocked", async () => {
    const plugin = loadScopePlugin();

    const out: string[] = [];
    const writer = (...args: unknown[]) => out.push(args.map(String).join(" "));

    const created = await invokePlugin(plugin, {
      source: "cli",
      args: ["create", "alpha", "--members", "neo,trinity", "--lead", "neo", "--ttl", "2026-06-08T00:00:00.000Z"],
      writer,
    });
    expect(created.ok).toBe(true);
    expect(stripAnsi(`${created.output ?? ""}\n${out.join("\n")}`)).toContain('created scope "alpha"');

    out.length = 0;
    const listed = await invokePlugin(plugin, { source: "cli", args: ["list"], writer });
    expect(listed.ok).toBe(true);
    const listOutput = stripAnsi(`${listed.output ?? ""}\n${out.join("\n")}`);
    expect(listOutput).toContain("alpha");
    expect(listOutput).toContain("neo,trinity");

    out.length = 0;
    const shown = await invokePlugin(plugin, { source: "cli", args: ["show", "alpha"], writer });
    expect(shown.ok).toBe(true);
    const parsed = JSON.parse(out.join("\n") || String(shown.output));
    expect(parsed).toMatchObject({
      name: "alpha",
      members: ["neo", "trinity"],
      lead: "neo",
      ttl: "2026-06-08T00:00:00.000Z",
    });

    const refused = await invokePlugin(plugin, { source: "cli", args: ["delete", "alpha"], writer });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("delete requires --yes");

    out.length = 0;
    const deleted = await invokePlugin(plugin, { source: "cli", args: ["delete", "alpha", "--yes"], writer });
    expect(deleted.ok).toBe(true);
    expect(stripAnsi(`${deleted.output ?? ""}\n${out.join("\n")}`)).toContain('deleted scope "alpha"');
  });
});
