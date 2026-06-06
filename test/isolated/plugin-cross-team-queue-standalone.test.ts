import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "../..");
const pluginRoot = join(root, "src/vendor/mpr-plugins/cross-team-queue");

const { handle } = await import("../../src/vendor/mpr-plugins/cross-team-queue/src/index.ts?plugin-cross-team-queue-standalone");

describe("cross-team-queue plugin standalone boundary (#2250)", () => {
  test("ships as a source plugin with expected manifest metadata", () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8"));

    expect(manifest).toMatchObject({
      name: "cross-team-queue",
      version: "0.1.2",
      description: expect.stringContaining("Unified inbox view"),
      schemaVersion: 1,
      entry: "./src/index.ts",
      api: { path: "/cross-team-queue", methods: ["GET"] },
    });
    expect(manifest.sdk).toMatch(/^\^1\.0\.0-alpha/);
  });

  test("keeps runtime source free of maw core imports", () => {
    const files = ["src/index.ts", "src/types.ts"].map((file) => readFileSync(join(pluginRoot, file), "utf8"));

    for (const source of files) {
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib|plugin)(?:\/|")/);
      expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
    }
  });

  test("returns the stable empty QueueResponse contract", async () => {
    await expect(handle({ recipient: "neo", team: "alpha", type: "handoff", maxAgeHours: 24 })).resolves.toEqual({
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
