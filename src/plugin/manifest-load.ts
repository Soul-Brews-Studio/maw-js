/**
 * Plugin manifest — loadManifestFromDir: read plugin.json from a directory.
 */

import type { LoadedPlugin } from "./types";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { createRequire } from "node:module";
import { parseManifest, parseManifestFromSource } from "./manifest-parse";

const requirePluginManifest = createRequire(import.meta.url);

function pickManifestExport(mod: unknown): unknown {
  if (!mod || typeof mod !== "object" || Array.isArray(mod)) return undefined;
  const candidate = mod as {
    default?: unknown;
    manifest?: unknown;
  };
  if (candidate.default !== undefined) return candidate.default;
  if (candidate.manifest !== undefined) return candidate.manifest;
  return mod;
}

/**
 * Load a plugin package from a directory.
 * Returns null if no plugin.json/plugin.ts is present.
 * Throws if a manifest is present but fails validation.
 */
export function loadManifestFromDir(dir: string): LoadedPlugin | null {
  const tsPath = join(dir, "plugin.ts");
  if (existsSync(tsPath)) {
    const loaded = requirePluginManifest(tsPath);
    const manifestObj = pickManifestExport(loaded);
    const manifest = parseManifestFromSource(manifestObj, dir, "plugin.ts");
    const hasWasm = !!manifest.wasm;
    const hasEntry = !!manifest.entry;
    const hasArtifactJs = manifest.target !== "wasm" && !!manifest.artifact?.path;
    const effectiveEntry = manifest.entry ?? (hasArtifactJs ? manifest.artifact!.path : undefined);
    return {
      manifest,
      dir,
      wasmPath: hasWasm ? resolve(dir, manifest.wasm!) : "",
      ...(effectiveEntry ? { entryPath: resolve(dir, effectiveEntry) } : {}),
      kind: (hasEntry || hasArtifactJs) ? "ts" as const : "wasm" as const,
    };
  }

  const manifestPath = join(dir, "plugin.json");
  if (!existsSync(manifestPath)) return null;
  const jsonText = readFileSync(manifestPath, "utf8");
  const manifest = parseManifest(jsonText, dir);

  // Entry resolution precedence:
  //   1. manifest.entry (legacy source-tree plugins)
  //   2. manifest.artifact.path (v1 compiled plugins — maw plugin build output)
  //   3. manifest.wasm (WASM plugins)
  // A JS bundle compiled via `maw plugin build` has `target:"js"` + `artifact.path:"./index.js"`
  // but no `entry`. Without this precedence, such plugins fall through to `kind:"wasm"` and
  // the loader tries to read the artifact as a WASM module.
  const hasWasm = !!manifest.wasm;
  const hasEntry = !!manifest.entry;
  const hasArtifactJs = manifest.target !== "wasm" && !!manifest.artifact?.path;
  const effectiveEntry = manifest.entry ?? (hasArtifactJs ? manifest.artifact!.path : undefined);

  return {
    manifest,
    dir,
    wasmPath: hasWasm ? resolve(dir, manifest.wasm!) : "",
    ...(effectiveEntry ? { entryPath: resolve(dir, effectiveEntry) } : {}),
    kind: (hasEntry || hasArtifactJs) ? "ts" as const : "wasm" as const,
  };
}
