import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { invokePlugin } from "../../src/plugin/registry-invoke";
import type { LoadedPlugin } from "../../src/plugin/types";

const ROOT = new URL("../..", import.meta.url).pathname;
const pluginDir = join(ROOT, "src/vendor/mpr-plugins/oracle-skills");
const originalSpawnSync = Bun.spawnSync;

let spawnCalls: Array<{ argv: string[]; opts: Record<string, unknown> }>;
let spawnImpl: typeof Bun.spawnSync;

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

function loadOracleSkillsPlugin(): LoadedPlugin {
  const loaded = loadManifestFromDir(pluginDir);
  expect(loaded).not.toBeNull();
  return loaded as LoadedPlugin;
}

async function invokeCli(args: string[]) {
  return await invokePlugin(loadOracleSkillsPlugin(), { source: "cli", args });
}

beforeEach(() => {
  spawnCalls = [];
  spawnImpl = ((argv: string[], opts: Record<string, unknown>) => {
    spawnCalls.push({ argv, opts });
    return { exitCode: 0 } as ReturnType<typeof Bun.spawnSync>;
  }) as typeof Bun.spawnSync;
  Bun.spawnSync = ((argv: string[], opts: Record<string, unknown>) => spawnImpl(argv, opts)) as typeof Bun.spawnSync;
});

afterEach(() => {
  Bun.spawnSync = originalSpawnSync;
});

describe("oracle-skills plugin standalone boundary", () => {
  test("plugin sources stay off direct core/shared/lib/config/sdk imports", () => {
    const files = ["index.ts"].map((file) => readFileSync(join(pluginDir, file), "utf8"));
    const imports = files.flatMap(parseImportSpecs);

    expect(imports.filter((spec) => spec.startsWith("maw-js/core/") || spec.startsWith("maw-js/commands/shared/") || spec.startsWith("maw-js/lib/") || spec === "maw-js/config" || spec.startsWith("maw-js/config/") || spec === "maw-js/sdk")).toEqual([]);
    expect(imports).toEqual(["maw-js/plugin/types"]);
  });

  test("plugin loads from manifest and reports CLI metadata", async () => {
    const plugin = loadOracleSkillsPlugin();
    expect(plugin.manifest.name).toBe("oracle-skills");

    const result = await invokePlugin(plugin, { source: "cli", args: ["--help"] });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("oracle-skills v0.1.0");
    expect(result.output).toContain("maw oracle-skills");
    expect(spawnCalls).toEqual([]);
  });

  test("passes CLI arguments through to arra-oracle-skills with inherited stdio", async () => {
    const result = await invokeCli(["list", "--json"]);

    expect(result).toEqual({ ok: true, output: "" });
    expect(spawnCalls).toEqual([
      {
        argv: ["arra-oracle-skills", "list", "--json"],
        opts: { stdout: "inherit", stderr: "inherit", stdin: "inherit" },
      },
    ]);
  });

  test("non-zero upstream exit code becomes plugin failure", async () => {
    spawnImpl = ((argv: string[], opts: Record<string, unknown>) => {
      spawnCalls.push({ argv, opts });
      return { exitCode: 7 } as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;

    const result = await invokeCli(["install", "foo"]);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("arra-oracle-skills exited with code 7");
    expect(result.output).toBe("");
  });

  test("missing binary returns install hint", async () => {
    spawnImpl = (() => { throw new Error("ENOENT"); }) as typeof Bun.spawnSync;

    const result = await invokeCli(["list"]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("arra-oracle-skills not found on $PATH");
    expect(result.error).toContain("bun add -g arra-oracle-skills");
    expect(result.output).toBe("");
  });

  test("api invocation does not forward non-cli args", async () => {
    const result = await invokePlugin(loadOracleSkillsPlugin(), { source: "api", args: { ignored: true } });

    expect(result).toEqual({ ok: true, output: "" });
    expect(spawnCalls[0]?.argv).toEqual(["arra-oracle-skills"]);
  });
});
