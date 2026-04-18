/**
 * dts-gen.ts — opt-in .d.ts generation for plugin-specific types.
 *
 * Phase B Wave 1C (#340): `maw plugin build --types` emits
 * `dist/<name>.d.ts` alongside `dist/index.js`.
 *
 * Strategy: write a minimal tsconfig.emit.json into dist/, then run
 *   bun x tsc --project <tsconfig.emit.json> --emitDeclarationOnly
 * This avoids requiring tsc on PATH — bun x pulls typescript from
 * devDependencies or the global bun tool cache.
 *
 * The .d.ts is named <pluginName>.d.ts so plugin authors can re-export
 * or type-check against their specific plugin shape rather than the
 * generic SDK surface.
 *
 * Non-breaking: nothing calls this unless --types is passed. Existing
 * Phase A plugins are unaffected.
 */

import { existsSync, writeFileSync, unlinkSync, renameSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

export interface DtsGenOptions {
  /** Plugin source directory (contains src/, plugin.json). */
  pluginDir: string;
  /** Directory where dist/index.js was emitted. */
  distDir: string;
  /** Plugin name (used to name the output file). */
  pluginName: string;
  /** Absolute path to the plugin entry point (e.g. src/index.ts). */
  entryPath: string;
}

export interface DtsGenResult {
  /** Absolute path to the emitted .d.ts file. */
  dtsPath: string;
  /** tsc stderr output (may contain warnings even on success). */
  diagnostics: string;
}

/**
 * Generate `dist/<name>.d.ts` using `bun x tsc --emitDeclarationOnly`.
 *
 * Writes a temporary tsconfig.emit.json into distDir, runs tsc, then
 * removes the temporary config. Throws on tsc failure.
 */
export function generatePluginDts(opts: DtsGenOptions): DtsGenResult {
  const { pluginDir, distDir, pluginName, entryPath } = opts;

  if (!existsSync(entryPath)) {
    throw new Error(`dts-gen: entry not found: ${entryPath}`);
  }

  // Temporary tsconfig scoped to just the plugin source
  const tsconfigPath = join(distDir, "tsconfig.emit.json");
  const dtsPath = join(distDir, `${pluginName}.d.ts`);

  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      declaration: true,
      emitDeclarationOnly: true,
      outDir: distDir,
      rootDir: join(pluginDir, "src"),
      skipLibCheck: true,
      noEmit: false,
    },
    include: [join(pluginDir, "src", "**", "*")],
  };

  writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n");

  let diagnostics = "";
  try {
    const result = spawnSync(
      "bun",
      ["x", "tsc", "--project", tsconfigPath],
      { cwd: pluginDir, encoding: "utf8" },
    );

    diagnostics = (result.stderr || result.stdout || "").trim();

    if (result.status !== 0) {
      throw new Error(
        `tsc declaration emit failed (exit ${result.status}):\n${diagnostics || "(no output)"}`,
      );
    }
  } finally {
    // Always clean up the temp tsconfig
    try { unlinkSync(tsconfigPath); } catch { /* ignore */ }
  }

  // tsc emits index.d.ts (mirrors src/index.ts); rename to <pluginName>.d.ts
  const indexDts = join(distDir, "index.d.ts");
  if (existsSync(indexDts) && indexDts !== dtsPath) {
    renameSync(indexDts, dtsPath);
  }

  if (!existsSync(dtsPath)) {
    throw new Error(`dts-gen: expected ${dtsPath} but tsc did not emit it`);
  }

  return { dtsPath, diagnostics };
}
