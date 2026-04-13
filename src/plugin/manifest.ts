/**
 * Plugin manifest — parse, validate, and load plugin.json descriptors.
 *
 * Validation rules:
 *   name    — /^[a-z0-9-]+$/
 *   version — semver (N.N.N with optional pre-release/build)
 *   sdk     — semver range: *, N.N.N, ^N.N.N, ~N.N.N, >=N.N.N, etc.
 *   wasm    — relative path; file must exist on disk relative to manifest dir
 */

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import type { PluginManifest, LoadedPlugin } from "./types";

const NAME_RE = /^[a-z0-9-]+$/;

// Semver: N.N.N with optional pre-release (-alpha.1) and build metadata (+001)
const SEMVER_CORE = /\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?/;
const SEMVER_RE = new RegExp(`^${SEMVER_CORE.source}$`);

// Semver range: *, bare semver, or operator-prefixed semver (^, ~, >=, <=, >, <)
const SEMVER_RANGE_RE = new RegExp(
  `^(\\^|~|>=?|<=?)?${SEMVER_CORE.source}$|^\\*$`,
);

/**
 * Parse and validate a plugin.json text.
 * @param jsonText - raw contents of plugin.json
 * @param dir      - absolute directory of the manifest (used to resolve wasm path)
 * @throws if any field is missing, invalid, or the wasm file is absent
 */
export function parseManifest(jsonText: string, dir: string): PluginManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    throw new Error("plugin.json: invalid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("plugin.json: must be a JSON object");
  }
  const r = raw as Record<string, unknown>;

  // --- Required fields ---

  if (typeof r.name !== "string" || !NAME_RE.test(r.name)) {
    throw new Error(
      `plugin.json: name must match /^[a-z0-9-]+$/ (got ${JSON.stringify(r.name)})`,
    );
  }
  if (typeof r.version !== "string" || !SEMVER_RE.test(r.version)) {
    throw new Error(
      `plugin.json: version must be semver N.N.N (got ${JSON.stringify(r.version)})`,
    );
  }
  // Must have either wasm or entry (not both required, at least one)
  const hasWasm = typeof r.wasm === "string" && r.wasm.length > 0;
  const hasEntry = typeof r.entry === "string" && (r.entry as string).length > 0;
  if (!hasWasm && !hasEntry) {
    throw new Error("plugin.json: must have either 'wasm' (WASM plugin) or 'entry' (TS plugin)");
  }

  if (typeof r.sdk !== "string" || !SEMVER_RANGE_RE.test(r.sdk)) {
    throw new Error(
      `plugin.json: sdk must be a semver range (got ${JSON.stringify(r.sdk)})`,
    );
  }

  // Validate file exists on disk
  if (hasWasm) {
    const resolvedWasm = resolve(dir, r.wasm as string);
    if (!existsSync(resolvedWasm)) {
      throw new Error(`plugin.json: wasm file not found: ${resolvedWasm}`);
    }
  }
  if (hasEntry) {
    const resolvedEntry = resolve(dir, r.entry as string);
    if (!existsSync(resolvedEntry)) {
      throw new Error(`plugin.json: entry file not found: ${resolvedEntry}`);
    }
  }

  // --- Optional cli ---
  let cli: PluginManifest["cli"];
  if (r.cli !== undefined) {
    if (!r.cli || typeof r.cli !== "object" || Array.isArray(r.cli)) {
      throw new Error("plugin.json: cli must be an object");
    }
    const c = r.cli as Record<string, unknown>;
    if (typeof c.command !== "string" || !c.command) {
      throw new Error("plugin.json: cli.command must be a non-empty string");
    }
    cli = {
      command: c.command,
      ...(typeof c.help === "string" ? { help: c.help } : {}),
    };
  }

  // --- Optional api ---
  let api: PluginManifest["api"];
  if (r.api !== undefined) {
    if (!r.api || typeof r.api !== "object" || Array.isArray(r.api)) {
      throw new Error("plugin.json: api must be an object");
    }
    const a = r.api as Record<string, unknown>;
    if (typeof a.path !== "string" || !a.path) {
      throw new Error("plugin.json: api.path must be a non-empty string");
    }
    if (
      !Array.isArray(a.methods) ||
      a.methods.some((m: unknown) => m !== "GET" && m !== "POST")
    ) {
      throw new Error('plugin.json: api.methods must be an array of "GET" | "POST"');
    }
    api = { path: a.path, methods: a.methods as ("GET" | "POST")[] };
  }

  return {
    name: r.name,
    version: r.version,
    ...(hasWasm ? { wasm: r.wasm as string } : {}),
    ...(hasEntry ? { entry: r.entry as string } : {}),
    sdk: r.sdk,
    ...(cli ? { cli } : {}),
    ...(api ? { api } : {}),
    ...(typeof r.description === "string" ? { description: r.description } : {}),
    ...(typeof r.author === "string" ? { author: r.author } : {}),
  };
}

/**
 * Load a plugin package from a directory.
 * Returns null if no plugin.json is present.
 * Throws if plugin.json exists but fails validation.
 */
export function loadManifestFromDir(dir: string): LoadedPlugin | null {
  const manifestPath = join(dir, "plugin.json");
  if (!existsSync(manifestPath)) return null;
  const jsonText = readFileSync(manifestPath, "utf8");
  const manifest = parseManifest(jsonText, dir);
  const hasWasm = !!manifest.wasm;
  const hasEntry = !!manifest.entry;
  return {
    manifest,
    dir,
    wasmPath: hasWasm ? resolve(dir, manifest.wasm!) : "",
    ...(hasEntry ? { entryPath: resolve(dir, manifest.entry!) } : {}),
    kind: hasEntry ? "ts" as const : "wasm" as const,
  };
}
