/**
 * Plugin manifest — parseManifest: required field validation + assembly.
 */

import type { PluginManifest } from "./types";
import { existsSync } from "fs";
import { resolve } from "path";
import { NAME_RE, SEMVER_RE, SEMVER_RANGE_RE } from "./manifest-constants";
import {
  parseCli,
  parseApi,
  parseHooks,
  parseCron,
  parseModule,
  parseTransport,
  parseTarget,
  parseCapabilities,
  parseArtifact,
  parseTier,
} from "./manifest-validate";

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
  // Must have either wasm, entry, or a built artifact (at least one).
  const hasWasm = typeof r.wasm === "string" && r.wasm.length > 0;
  const hasEntry = typeof r.entry === "string" && (r.entry as string).length > 0;
  const hasArtifact = r.artifact !== undefined;
  if (!hasWasm && !hasEntry && !hasArtifact) {
    throw new Error(
      "plugin.json: must have 'wasm' (WASM plugin), 'entry' (TS plugin), or 'artifact' (built plugin)",
    );
  }

  // Optional weight (execution order: 0=first, 50=default, 99=last)
  if (r.weight !== undefined && (typeof r.weight !== "number" || r.weight < 0 || r.weight > 99)) {
    throw new Error("plugin.json: weight must be a number 0-99 (lower = runs first, default 50)");
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

  // --- Optional fields (delegated to manifest-validate helpers) ---
  const cli = parseCli(r);
  const api = parseApi(r);
  const hooks = parseHooks(r);
  const cron = parseCron(r);
  const module_ = parseModule(r);
  const transport = parseTransport(r);
  const target = parseTarget(r);
  const capabilities = parseCapabilities(r);
  const artifact = parseArtifact(r);
  const tier = parseTier(r);

  return {
    name: r.name,
    version: r.version,
    ...(typeof r.weight === "number" ? { weight: r.weight } : {}),
    ...(tier ? { tier } : {}),
    ...(hasWasm ? { wasm: r.wasm as string } : {}),
    ...(hasEntry ? { entry: r.entry as string } : {}),
    sdk: r.sdk,
    ...(cli ? { cli } : {}),
    ...(api ? { api } : {}),
    ...(typeof r.description === "string" ? { description: r.description } : {}),
    ...(typeof r.author === "string" ? { author: r.author } : {}),
    ...(hooks ? { hooks } : {}),
    ...(cron ? { cron } : {}),
    ...(module_ ? { module: module_ } : {}),
    ...(transport ? { transport } : {}),
    ...(target ? { target } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(artifact ? { artifact } : {}),
  };
}
