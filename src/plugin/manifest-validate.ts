/**
 * Plugin manifest — optional-field validators for parseManifest.
 * Each function validates and shapes one optional manifest section.
 */

import type { PluginManifest, PluginTier } from "./types";
import { KNOWN_CAPABILITY_NAMESPACES } from "./manifest-constants";

const VALID_TIERS = new Set<PluginTier>(["core", "standard", "extra"]);

export function parseCli(r: Record<string, unknown>): PluginManifest["cli"] {
  if (r.cli === undefined) return undefined;
  if (!r.cli || typeof r.cli !== "object" || Array.isArray(r.cli)) {
    throw new Error("plugin.json: cli must be an object");
  }
  const c = r.cli as Record<string, unknown>;
  if (typeof c.command !== "string" || !c.command) {
    throw new Error("plugin.json: cli.command must be a non-empty string");
  }
  if (c.aliases !== undefined) {
    if (!Array.isArray(c.aliases) || c.aliases.some((a: unknown) => typeof a !== "string")) {
      throw new Error("plugin.json: cli.aliases must be an array of strings");
    }
  }
  if (c.flags !== undefined) {
    if (!c.flags || typeof c.flags !== "object" || Array.isArray(c.flags)) {
      throw new Error("plugin.json: cli.flags must be an object");
    }
    const valid = new Set(["boolean", "string", "number"]);
    for (const [k, v] of Object.entries(c.flags as Record<string, unknown>)) {
      if (!valid.has(v as string)) {
        throw new Error(`plugin.json: cli.flags["${k}"] must be "boolean", "string", or "number"`);
      }
    }
  }
  return {
    command: c.command,
    ...(Array.isArray(c.aliases) ? { aliases: c.aliases as string[] } : {}),
    ...(typeof c.help === "string" ? { help: c.help } : {}),
    ...(c.flags ? { flags: c.flags as Record<string, string> } : {}),
  };
}

export function parseApi(r: Record<string, unknown>): PluginManifest["api"] {
  if (r.api === undefined) return undefined;
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
  return { path: a.path, methods: a.methods as ("GET" | "POST")[] };
}

export function parseHooks(r: Record<string, unknown>): PluginManifest["hooks"] {
  if (r.hooks === undefined) return undefined;
  if (!r.hooks || typeof r.hooks !== "object" || Array.isArray(r.hooks)) {
    throw new Error("plugin.json: hooks must be an object");
  }
  const h = r.hooks as Record<string, unknown>;
  for (const key of ["gate", "filter", "on", "late"] as const) {
    if (h[key] !== undefined) {
      if (!Array.isArray(h[key]) || (h[key] as unknown[]).some((e: unknown) => typeof e !== "string")) {
        throw new Error(`plugin.json: hooks.${key} must be an array of strings`);
      }
    }
  }
  return {
    ...(Array.isArray(h.gate) ? { gate: h.gate as string[] } : {}),
    ...(Array.isArray(h.filter) ? { filter: h.filter as string[] } : {}),
    ...(Array.isArray(h.on) ? { on: h.on as string[] } : {}),
    ...(Array.isArray(h.late) ? { late: h.late as string[] } : {}),
  };
}

export function parseCron(r: Record<string, unknown>): PluginManifest["cron"] {
  if (r.cron === undefined) return undefined;
  if (!r.cron || typeof r.cron !== "object" || Array.isArray(r.cron)) {
    throw new Error("plugin.json: cron must be an object");
  }
  const c = r.cron as Record<string, unknown>;
  if (typeof c.schedule !== "string" || !c.schedule) {
    throw new Error("plugin.json: cron.schedule must be a non-empty string");
  }
  if (c.handler !== undefined && typeof c.handler !== "string") {
    throw new Error("plugin.json: cron.handler must be a string");
  }
  return {
    schedule: c.schedule,
    ...(typeof c.handler === "string" ? { handler: c.handler } : {}),
  };
}

export function parseModule(r: Record<string, unknown>): PluginManifest["module"] {
  if (r.module === undefined) return undefined;
  if (!r.module || typeof r.module !== "object" || Array.isArray(r.module)) {
    throw new Error("plugin.json: module must be an object");
  }
  const m = r.module as Record<string, unknown>;
  if (!Array.isArray(m.exports) || m.exports.length === 0 || m.exports.some((e: unknown) => typeof e !== "string")) {
    throw new Error("plugin.json: module.exports must be a non-empty array of strings");
  }
  if (typeof m.path !== "string" || !m.path) {
    throw new Error("plugin.json: module.path must be a non-empty string");
  }
  return { exports: m.exports as string[], path: m.path };
}

export function parseTransport(r: Record<string, unknown>): PluginManifest["transport"] {
  if (r.transport === undefined) return undefined;
  if (!r.transport || typeof r.transport !== "object" || Array.isArray(r.transport)) {
    throw new Error("plugin.json: transport must be an object");
  }
  const t = r.transport as Record<string, unknown>;
  if (t.peer !== undefined && typeof t.peer !== "boolean") {
    throw new Error("plugin.json: transport.peer must be a boolean");
  }
  return {
    ...(typeof t.peer === "boolean" ? { peer: t.peer } : {}),
  };
}

export function parseTarget(r: Record<string, unknown>): PluginManifest["target"] {
  if (r.target === undefined) return undefined;
  if (typeof r.target !== "string") {
    throw new Error("plugin.json: target must be a string");
  }
  if (r.target === "wasm") {
    throw new Error(
      'plugin.json: target "wasm" not yet supported (Phase C). Use target "js" for now.',
    );
  }
  if (r.target !== "js") {
    throw new Error(
      `plugin.json: unknown target ${JSON.stringify(r.target)} (expected "js")`,
    );
  }
  return r.target;
}

/**
 * Parse + validate the optional `capabilities` field.
 *
 * Single source of truth: KNOWN_CAPABILITY_NAMESPACES from manifest-constants.
 * This function runs at BOTH install time (parseManifest in plugins-install)
 * AND load time (parseManifest via loadManifestFromDir → discoverPackages).
 * Both paths must use the same canonical set — never hardcode the list
 * anywhere else. See #902 / test/isolated/plugin-load-capability-902.test.ts.
 */
export function parseCapabilities(r: Record<string, unknown>): PluginManifest["capabilities"] {
  if (r.capabilities === undefined) return undefined;
  if (
    !Array.isArray(r.capabilities) ||
    r.capabilities.some((c: unknown) => typeof c !== "string")
  ) {
    throw new Error("plugin.json: capabilities must be an array of strings");
  }
  const capabilities = r.capabilities as string[];
  for (const cap of capabilities) {
    const idx = cap.indexOf(":");
    const ns = idx === -1 ? cap : cap.slice(0, idx);
    if (!KNOWN_CAPABILITY_NAMESPACES.has(ns)) {
      console.warn(
        `plugin.json: unknown capability namespace "${ns}" in "${cap}" ` +
          `(known: ${[...KNOWN_CAPABILITY_NAMESPACES].join(", ")})`,
      );
    }
  }
  return capabilities;
}

export function parseArtifact(r: Record<string, unknown>): PluginManifest["artifact"] {
  if (r.artifact === undefined) return undefined;
  if (!r.artifact || typeof r.artifact !== "object" || Array.isArray(r.artifact)) {
    throw new Error("plugin.json: artifact must be an object");
  }
  const a = r.artifact as Record<string, unknown>;
  if (typeof a.path !== "string" || !a.path) {
    throw new Error("plugin.json: artifact.path must be a non-empty string");
  }
  if (a.sha256 !== null && typeof a.sha256 !== "string") {
    throw new Error("plugin.json: artifact.sha256 must be a string or null");
  }
  return { path: a.path, sha256: (a.sha256 as string | null) ?? null };
}

/**
 * Parse optional `tier` field (#675).
 * Must be one of "core" | "standard" | "extra".
 * Missing → undefined (caller falls back to weightToTier).
 */
export function parseTier(r: Record<string, unknown>): PluginManifest["tier"] {
  if (r.tier === undefined) return undefined;
  if (typeof r.tier !== "string" || !VALID_TIERS.has(r.tier as PluginTier)) {
    throw new Error(
      `plugin.json: tier must be "core", "standard", or "extra" (got ${JSON.stringify(r.tier)})`,
    );
  }
  return r.tier as PluginTier;
}
