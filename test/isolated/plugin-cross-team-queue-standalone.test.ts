import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import type { LoadedPlugin } from "../../src/plugin/types";

const ROOT = new URL("../..", import.meta.url).pathname;
const pluginDir = join(ROOT, "src/vendor/mpr-plugins/cross-team-queue");

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name.startsWith(".")) continue;
      out.push(...walkSources(full));
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) &&
      entry.name !== "plugin.ts"
    ) {
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

describe("cross-team-queue plugin standalone boundary", () => {
  test("plugin manifest loads with schema metadata", () => {
    const loaded = loadManifestFromDir(pluginDir);

    expect(loaded).not.toBeNull();
    const plugin = loaded as LoadedPlugin;
    expect(plugin.manifest).toMatchObject({
      name: "cross-team-queue",
      entry: "./src/index.ts",
    });
  });

  test("source has zero runtime dependencies outside relative modules", () => {
    const imports = walkSources(pluginDir).flatMap((file) => parseImportSpecs(readFileSync(file, "utf8")));

    const disallowed = imports.filter((spec) => !spec.startsWith("."));

    expect(disallowed).toEqual([]);
  });

  test("handler returns the empty schema-v1 queue response", async () => {
    const mod = await import("../../src/vendor/mpr-plugins/cross-team-queue/src/index.ts?plugin-cross-team-queue-standalone");

    const result = await mod.handle({ recipient: "neo", type: "handoff", maxAgeHours: 24 });

    expect(result).toEqual({
      items: [],
      stats: {
        totalItems: 0,
        byRecipient: {},
        byType: {},
        oldestAgeHours: null,
        newestAgeHours: null,
      },
      errors: [],
      schemaVersion: 1,
    });
  });
});
