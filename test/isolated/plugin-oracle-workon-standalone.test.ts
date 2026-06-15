import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const root = join(import.meta.dir, "../..");
const pluginDir = join(root, "src/vendor/mpr-plugins/oracle-workon");

describe("oracle-workon plugin standalone boundary", () => {
  test("keeps imports on the standalone SDK boundary", () => {
    const manifest = JSON.parse(readFileSync(join(pluginDir, "plugin.json"), "utf8"));
    expect(manifest.name).toBe("oracle-workon");
    expect(manifest.cli?.command).toBe("oracle-workon");

    const imports = expectStandalonePluginBoundary({
      plugin: "oracle-workon",
      requireSdk: false,
      allowMawJs: ["maw-js/commands/shared/wake-cwd"],
    });

    expect(imports.map((record) => record.spec)).toContain("maw-js/commands/shared/wake-cwd");
  });
});
