/**
 * plugin-dts-gen-extra-coverage.test.ts
 *
 * Focused branch coverage for dts-gen failure and diagnostic paths. These tests
 * stub Bun.spawnSync inside an isolated test file so no external tsc process is
 * needed and no mock state leaks into other files.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generatePluginDts } from "../../src/commands/plugins/plugin/dts-gen";

const created: string[] = [];
const originalSpawnSync = Bun.spawnSync;
const encoder = new TextEncoder();

function tempPlugin(name = "typed") {
  const pluginDir = mkdtempSync(join(tmpdir(), "maw-dts-extra-"));
  created.push(pluginDir);
  const srcDir = join(pluginDir, "src");
  const distDir = join(pluginDir, "dist");
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  const entryPath = join(srcDir, "index.ts");
  writeFileSync(entryPath, "export const value = 1;\n");
  return { pluginDir, distDir, pluginName: name, entryPath };
}

function spawnResult(exitCode: number, stdout = "", stderr = "") {
  return {
    exitCode,
    stdout: encoder.encode(stdout),
    stderr: encoder.encode(stderr),
  } as unknown as ReturnType<typeof Bun.spawnSync>;
}

afterEach(() => {
  Bun.spawnSync = originalSpawnSync;
  for (const dir of created.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("generatePluginDts edge branches", () => {
  test("surfaces stderr diagnostics when declaration emit fails and removes temp config", () => {
    const plugin = tempPlugin("broken");
    Bun.spawnSync = (() => spawnResult(2, "unused stdout", "tsc exploded")) as typeof Bun.spawnSync;

    expect(() => generatePluginDts(plugin)).toThrow(
      "tsc declaration emit failed (exit 2):\ntsc exploded",
    );
    expect(existsSync(join(plugin.distDir, "tsconfig.emit.json"))).toBe(false);
  });

  test("falls back to stdout diagnostics and reports no-output failures", () => {
    const stdoutPlugin = tempPlugin("stdout-fail");
    Bun.spawnSync = (() => spawnResult(1, "stdout-only diagnostic", "")) as typeof Bun.spawnSync;
    expect(() => generatePluginDts(stdoutPlugin)).toThrow("stdout-only diagnostic");

    const silentPlugin = tempPlugin("silent-fail");
    Bun.spawnSync = (() => spawnResult(1, "", "")) as typeof Bun.spawnSync;
    expect(() => generatePluginDts(silentPlugin)).toThrow(
      "tsc declaration emit failed (exit 1):\n(no output)",
    );
  });

  test("renames emitted index declaration and returns trimmed success diagnostics", () => {
    const plugin = tempPlugin("renamed");
    Bun.spawnSync = (() => {
      writeFileSync(join(plugin.distDir, "index.d.ts"), "export declare const value = 1;\n");
      return spawnResult(0, "  stdout warning  \n", "");
    }) as typeof Bun.spawnSync;

    const result = generatePluginDts(plugin);

    expect(result).toEqual({
      dtsPath: join(plugin.distDir, "renamed.d.ts"),
      diagnostics: "stdout warning",
    });
    expect(existsSync(join(plugin.distDir, "index.d.ts"))).toBe(false);
    expect(readFileSync(result.dtsPath, "utf8")).toContain("value");
    expect(existsSync(join(plugin.distDir, "tsconfig.emit.json"))).toBe(false);
  });

  test("accepts a declaration already emitted at the final plugin path", () => {
    const plugin = tempPlugin("already-final");
    Bun.spawnSync = (() => {
      writeFileSync(join(plugin.distDir, "already-final.d.ts"), "export declare const done = true;\n");
      return spawnResult(0, "", "  stderr warning  \n");
    }) as typeof Bun.spawnSync;

    const result = generatePluginDts(plugin);

    expect(result.dtsPath).toBe(join(plugin.distDir, "already-final.d.ts"));
    expect(result.diagnostics).toBe("stderr warning");
    expect(readFileSync(result.dtsPath, "utf8")).toContain("done");
  });

  test("throws when tsc succeeds without emitting a declaration", () => {
    const plugin = tempPlugin("missing-output");
    Bun.spawnSync = (() => spawnResult(0)) as typeof Bun.spawnSync;

    expect(() => generatePluginDts(plugin)).toThrow(
      `dts-gen: expected ${join(plugin.distDir, "missing-output.d.ts")} but tsc did not emit it`,
    );
    expect(existsSync(join(plugin.distDir, "tsconfig.emit.json"))).toBe(false);
  });
});
