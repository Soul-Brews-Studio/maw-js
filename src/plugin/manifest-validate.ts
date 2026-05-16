/**
 * Plugin manifest — optional-field validators for parseManifest.
 * Each function validates and shapes one optional manifest section.
 */

import type { PluginLifecycleHook, PluginManifest, PluginTier } from "./types";
import { KNOWN_CAPABILITY_NAMESPACES, NAME_RE } from "./manifest-constants";
import { getRuntimeVersionString } from "../core/runtime/build-info";

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

function parseLifecycleHook(hooks: Record<string, unknown>, key: "wake" | "sleep" | "serve"): PluginLifecycleHook | undefined {
  const raw = hooks[key];
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`plugin.json: hooks.${key} must be an object`);
  }
  const h = raw as Record<string, unknown>;
  if (h.script !== undefined && (typeof h.script !== "string" || !h.script)) {
    throw new Error(`plugin.json: hooks.${key}.script must be a non-empty string`);
  }
  if (h.handler !== undefined && (typeof h.handler !== "string" || !h.handler)) {
    throw new Error(`plugin.json: hooks.${key}.handler must be a non-empty string`);
  }
  if (h.ensures !== undefined) {
    if (!Array.isArray(h.ensures) || (h.ensures as unknown[]).some((e: unknown) => typeof e !== "string" || !e)) {
      throw new Error(`plugin.json: hooks.${key}.ensures must be an array of non-empty strings`);
    }
  }
  if (h.policy !== undefined && h.policy !== "best-effort" && h.policy !== "fail-fast") {
    throw new Error(`plugin.json: hooks.${key}.policy must be "best-effort" or "fail-fast"`);
  }
  return {
    ...(typeof h.script === "string" ? { script: h.script } : {}),
    ...(typeof h.handler === "string" ? { handler: h.handler } : {}),
    ...(Array.isArray(h.ensures) ? { ensures: h.ensures as string[] } : {}),
    ...(typeof h.policy === "string" ? { policy: h.policy as PluginLifecycleHook["policy"] } : {}),
  };
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
  const wake = parseLifecycleHook(h, "wake");
  const sleep = parseLifecycleHook(h, "sleep");
  const serve = parseLifecycleHook(h, "serve");
  return {
    ...(Array.isArray(h.gate) ? { gate: h.gate as string[] } : {}),
    ...(Array.isArray(h.filter) ? { filter: h.filter as string[] } : {}),
    ...(Array.isArray(h.on) ? { on: h.on as string[] } : {}),
    ...(Array.isArray(h.late) ? { late: h.late as string[] } : {}),
    ...(wake ? { wake } : {}),
    ...(sleep ? { sleep } : {}),
    ...(serve ? { serve } : {}),
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

export function parseEngine(r: Record<string, unknown>): PluginManifest["engine"] {
  if (r.engine === undefined) return undefined;
  if (!r.engine || typeof r.engine !== "object" || Array.isArray(r.engine)) {
    throw new Error("plugin.json: engine must be an object");
  }
  const e = r.engine as Record<string, unknown>;
  if (e.serve === undefined) return {};
  if (!e.serve || typeof e.serve !== "object" || Array.isArray(e.serve)) {
    throw new Error("plugin.json: engine.serve must be an object");
  }
  const serve = e.serve as Record<string, unknown>;
  if (serve.command !== undefined && (typeof serve.command !== "string" || !serve.command)) {
    throw new Error("plugin.json: engine.serve.command must be a non-empty string");
  }
  if (serve.prefix !== undefined) {
    if (typeof serve.prefix !== "string" || !serve.prefix.startsWith("/api/")) {
      throw new Error("plugin.json: engine.serve.prefix must start with /api/");
    }
  }
  if (serve.health !== undefined) {
    if (typeof serve.health !== "string" || !serve.health.startsWith("/")) {
      throw new Error("plugin.json: engine.serve.health must be an absolute path");
    }
  }
  if (serve.eventPath !== undefined) {
    if (typeof serve.eventPath !== "string" || !serve.eventPath.startsWith("/")) {
      throw new Error("plugin.json: engine.serve.eventPath must be an absolute path");
    }
  }
  if (serve.events !== undefined) {
    if (!Array.isArray(serve.events) || serve.events.some((event: unknown) => typeof event !== "string" || !event)) {
      throw new Error("plugin.json: engine.serve.events must be an array of non-empty strings");
    }
  }
  return {
    serve: {
      ...(typeof serve.command === "string" ? { command: serve.command } : {}),
      ...(typeof serve.prefix === "string" ? { prefix: serve.prefix } : {}),
      ...(typeof serve.health === "string" ? { health: serve.health } : {}),
      ...(Array.isArray(serve.events) ? { events: serve.events as string[] } : {}),
      ...(typeof serve.eventPath === "string" ? { eventPath: serve.eventPath } : {}),
    },
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
export function parseCapabilityNamespaces(r: Record<string, unknown>): PluginManifest["capabilityNamespaces"] {
  if (r.capabilityNamespaces === undefined) return undefined;
  if (
    !Array.isArray(r.capabilityNamespaces) ||
    r.capabilityNamespaces.some((ns: unknown) => typeof ns !== "string" || !NAME_RE.test(ns))
  ) {
    throw new Error("plugin.json: capabilityNamespaces must be an array of slug strings");
  }
  return [...new Set(r.capabilityNamespaces as string[])];
}

export function parseCapabilities(
  r: Record<string, unknown>,
  extraNamespaces: Iterable<string> = [],
): PluginManifest["capabilities"] {
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
    const allowedNamespaces = new Set([...KNOWN_CAPABILITY_NAMESPACES, ...extraNamespaces]);
    if (!allowedNamespaces.has(ns)) {
      console.warn(
        `plugin.json: unknown capability namespace "${ns}" in "${cap}" ` +
          `(known: ${[...allowedNamespaces].join(", ")})\n` +
          `  ↳ runtime: ${getRuntimeVersionString()} — if this namespace is expected, update maw: ` +
          `bun add -g github:Soul-Brews-Studio/maw-js#alpha`,
      );
    }
  }
  return capabilities;
}

export function parseDependencies(r: Record<string, unknown>): PluginManifest["dependencies"] {
  if (r.dependencies === undefined) return undefined;

  const raw = r.dependencies;
  let plugins: unknown;
  if (Array.isArray(raw)) {
    // Compact legacy-friendly shape: "dependencies": ["trace", "dig"]
    plugins = raw;
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    plugins = (raw as Record<string, unknown>).plugins;
  } else {
    throw new Error("plugin.json: dependencies must be an object or array of plugin names");
  }

  if (plugins === undefined) return {};
  if (!Array.isArray(plugins) || plugins.some((p: unknown) => typeof p !== "string" || !NAME_RE.test(p))) {
    throw new Error("plugin.json: dependencies.plugins must be an array of plugin names");
  }
  return { plugins: plugins as string[] };
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
