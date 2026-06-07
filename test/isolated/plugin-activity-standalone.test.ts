import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadManifestFromDir } from "../../src/plugin/manifest-load";
import { invokePlugin } from "../../src/plugin/registry-invoke";
import type { LoadedPlugin } from "../../src/plugin/types";

const ROOT = new URL("../..", import.meta.url).pathname;
const pluginDir = join(ROOT, "src/vendor/mpr-plugins/activity");

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

function loadActivityPlugin(): LoadedPlugin {
  const loaded = loadManifestFromDir(pluginDir);
  expect(loaded).not.toBeNull();
  return loaded as LoadedPlugin;
}

const activity = await import("../../src/vendor/mpr-plugins/activity/impl.ts?plugin-activity-standalone");

describe("activity plugin standalone boundary (#2190)", () => {
  test("imports fleet helpers through SDK instead of commands/shared", () => {
    const index = readFileSync(join(pluginDir, "index.ts"), "utf8");
    const impl = readFileSync(join(pluginDir, "impl.ts"), "utf8");
    const imports = [index, impl].flatMap(parseImportSpecs);

    expect(imports).toContain("maw-js/sdk");
    expect(impl).toContain("matchesEngineIdlePrompt");
    expect(imports).toContain("maw-js/cli/parse-args");
    expect(imports).toContain("maw-js/plugin/types");
    expect(imports).not.toContain("maw-js/commands/shared/fleet-load");
    expect(imports.filter((spec) => spec.startsWith("maw-js/commands/shared/"))).toEqual([]);
    expect(imports.filter((spec) => spec.startsWith("maw-js/core/"))).toEqual([]);
  });

  test("plugin loads from manifest and usage path works", async () => {
    const result = await invokePlugin(loadActivityPlugin(), { source: "cli", args: ["--help"] });

    expect(result.ok).toBe(true);
    expect(result.output || "").toContain("activity v1.0.0");
    expect(result.output || "").toContain("maw activity <pane>");
  });

  test("sampleActivity classifies busy panes with mocked SDK dependency surface", async () => {
    let now = 1_000;
    const snapshots = ["prompt> waiting", "prompt> working"]; 

    const result = await activity.sampleActivity("alpha:work", { samples: 2, window: "1s" }, {
      listSessions: async () => [{ name: "alpha", windows: [{ index: 1, name: "work" }] }],
      findWindow: () => "alpha:1",
      snapshotPane: async (pane: string) => `${pane}: ${snapshots.shift()}`,
      sleep: async () => { now += 1_000; },
      now: () => now,
    });

    expect(result).toMatchObject({
      pane: "alpha:work",
      state: "busy",
      confidence: "medium",
      samples: 2,
      diff_samples: 2,
      sample_window_seconds: 1,
    });
  });

  test("sampleAllActivity reads fleet entries through dependency boundary", async () => {
    let now = 10_000;
    const result = await activity.sampleAllActivity({ samples: 2, window: "1s", json: true }, {
      loadFleetEntries: () => [
        { file: "fleet.json", groupName: "fleet", session: { name: "alpha", windows: [{ name: "one", repo: "" }, { name: "two", repo: "" }] } },
      ],
      listSessions: async () => [{ name: "alpha", windows: [{ index: 0, name: "one" }, { index: 1, name: "two" }] }],
      findWindow: (_sessions: unknown, target: string) => target === "alpha:one" ? "alpha:0" : "alpha:1",
      snapshotPane: async () => "❯ ",
      sleep: async () => { now += 1_000; },
      now: () => now,
      allConcurrency: 1,
    });

    expect(result.map((row: any) => [row.pane, row.state])).toEqual([
      ["alpha:one", "stuck"],
      ["alpha:two", "stuck"],
    ]);
  });
});
