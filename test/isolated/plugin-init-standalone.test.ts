import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const root = join(import.meta.dir, "../..");
const { command, default: initHandler } = await import("../../src/vendor/mpr-plugins/init/index.ts?plugin-init-standalone");
const { buildConfig } = await import("../../src/vendor/mpr-plugins/init/write-config.ts?plugin-init-standalone");

describe("init plugin standalone boundary (#2316/#2708)", () => {
  test("all init sources use SDK/plugin public boundaries for engine seed", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "init",
      root,
      allowMawJs: [
        "maw-js/core/paths",
        "maw-js/commands/shared/fleet-load",
        "maw-js/plugin/registry",
        "maw-js/plugin/manifest",
      ],
      allowRelative: ["../../../config/engine-registry", "../../../../core/xdg"],
    });

    expect(command).toMatchObject({ name: "init" });
    expect(imports.map((record) => record.spec)).toContain("maw-js/sdk");

    const sdk = readFileSync(join(root, "src/sdk/index.ts"), "utf8");
    expect(sdk).toContain("ENGINE_SEED");
  });

  test("buildConfig seeds config.engines including omx without legacy default commands", () => {
    const config = buildConfig({ node: "white" }) as any;

    expect(config.engines).toMatchObject({
      claude: { name: "claude", cmd: "claude" },
      codex: { name: "codex", cmd: "codex" },
      omx: { name: "omx", cmd: "omx" },
    });
    expect(config.commands).toEqual({});
  });

  test("CLI help stays standalone and side-effect free", async () => {
    const result = await initHandler({ source: "cli", args: ["--help"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("maw init");
  });
});
