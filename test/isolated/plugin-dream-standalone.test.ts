import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { invokePlugin } from "../../src/plugin/registry-invoke";
import type { LoadedPlugin } from "../../src/plugin/types";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const ROOT = new URL("../..", import.meta.url).pathname;
const pluginDir = join(ROOT, "src/vendor/mpr-plugins/dream");

let hostExecCalls: string[];
let ghqRoot: string;
let fleet: any[];
let tempCwd = "";
let fetchCalls: string[];

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  hostExec: async (command: string) => {
    hostExecCalls.push(command);
    if (command === "ghq list -p 2>/dev/null") return "";
    return "";
  },
  getGhqRoot: () => ghqRoot,
  loadFleetCore: () => fleet,
}));

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

function loadDreamPlugin(): LoadedPlugin {
  const loaded = loadManifestFromDir(pluginDir);
  expect(loaded).not.toBeNull();
  return loaded as LoadedPlugin;
}

async function invokeCli(args: string[]) {
  const out: string[] = [];
  const result = await invokePlugin(loadDreamPlugin(), {
    source: "cli",
    args,
    writer: (...parts: unknown[]) => out.push(parts.map(String).join(" ")),
  });
  return { result, output: out.join("\n") };
}

beforeEach(() => {
  hostExecCalls = [];
  fleet = [];
  tempCwd = mkdtempSync(join(tmpdir(), "maw-dream-plugin-"));
  ghqRoot = join(tempCwd, "ghq");
  fetchCalls = [];
  process.chdir(tempCwd);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    return new Response("offline", { status: 503 });
  }) as typeof fetch;
});

afterEach(() => {
  process.chdir(originalCwd);
  globalThis.fetch = originalFetch;
  if (tempCwd && existsSync(tempCwd)) rmSync(tempCwd, { recursive: true, force: true });
});

describe("dream plugin standalone boundary (#2222)", () => {
  test("plugin sources stay off direct core/shared/lib/config imports", () => {
    const files = ["index.ts", "impl.ts"].map((file) => readFileSync(join(pluginDir, file), "utf8"));
    const imports = files.flatMap(parseImportSpecs);

    expect(imports.filter((spec) => spec.startsWith("maw-js/core/") || spec.startsWith("maw-js/commands/shared/") || spec.startsWith("maw-js/lib/") || spec === "maw-js/config" || spec.startsWith("maw-js/config/"))).toEqual([]);
    expect(imports).toEqual(expect.arrayContaining(["maw-js/plugin/types", "maw-js/sdk"]));
  });

  test("plugin loads from manifest and renders CLI help without host access", async () => {
    const plugin = loadDreamPlugin();
    expect(plugin.manifest.name).toBe("dream");

    const { result, output } = await invokeCli(["--help"]);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("dream v0.1.0");
    expect(result.output).toContain("usage: maw dream");
    expect(result.output).toContain("--project");
    expect(output).toBe("");
    expect(hostExecCalls).toEqual([]);
    expect(fetchCalls).toEqual([]);
  });

  test("default dream scans through SDK helpers and saves a briefing offline", async () => {
    const { result, output } = await invokeCli([]);

    expect(result.ok).toBe(true);
    expect(fetchCalls[0]).toContain("/api/search?q=test&limit=1");
    expect(hostExecCalls).toEqual(["ghq list -p 2>/dev/null"]);
    expect(output).toContain("Dream");
    expect(output).toContain("dreaming");
    expect(output).toContain("saved →");
    expect(existsSync(join(tempCwd, "ψ", "writing", "dreams"))).toBe(true);
  });

  test("project flag reports known projects from SDK fleet repos", async () => {
    fleet = [{ name: "fleet", windows: [{ name: "ghost", repo: "Soul-Brews-Studio/ghost-oracle" }] }];

    const { result, output } = await invokeCli(["--project", "missing"]);

    expect(result.ok).toBe(true);
    expect(output).toContain("Dream — deep dive: missing");
    expect(output).toContain("project \"missing\" not found");
    expect(output).toContain("known:");
  });
});
