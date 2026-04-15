/**
 * Plugin registry — discover plugin packages and invoke them.
 *
 * Scans the canonical plugin install directory for packages with a plugin.json:
 *   ~/.maw/plugins/<name>/plugin.json
 *
 * Reuses wasm-bridge.ts infra (buildImportObject, preCacheBridge, readString, textEncoder).
 * Timeout: 5s hard limit matching command-registry.ts:193 pattern.
 *
 * ── Phase A gates (enforced at load time, not call-time) ────────────────────
 *  1. Semver gate — `manifest.sdk` must satisfy the runtime SDK version.
 *     Mismatch → plugin refused with an actionable error message.
 *  2. Artifact hash — if `manifest.artifact.sha256` is set on a real (non-symlink)
 *     install, the on-disk bundle's sha256 must match. Mismatch → refuse.
 *  3. Dev-mode (symlink) detection — if ~/.maw/plugins/<name>/ is a symlink,
 *     we treat it as a `linked (dev)` install and skip hash verification
 *     entirely. This replaces the rejected `sha256: "dev"` sentinel idea
 *     (sdk-consumer's cleaner label-only approach).
 *  4. Legacy manifests (no artifact field) still load — warn once, allow.
 */

import { createHash } from "crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadManifestFromDir } from "./manifest";
import { loadConfig } from "../config";
import {
  buildImportObject,
  preCacheBridge,
  readString,
  textEncoder,
} from "../cli/wasm-bridge";
import { verbose, warn, info } from "../cli/verbosity";
import type { LoadedPlugin, InvokeContext, InvokeResult } from "./types";

const PLUGIN_INVOKE_TIMEOUT_MS = 5_000;
const WASM_MEMORY_MAX_PAGES = 256; // 16MB

// Single scan dir — everything lives in ~/.maw/plugins/ (or MAW_PLUGINS_DIR
// if set). Resolved at call time so tests can override the root.
function scanDirs(): string[] {
  return [process.env.MAW_PLUGINS_DIR || join(homedir(), ".maw", "plugins")];
}

/** Runtime SDK version — read from @maw/sdk package.json. Canonical per the plan. */
let _runtimeSdkVersion: string | null = null;
export function runtimeSdkVersion(): string {
  if (_runtimeSdkVersion) return _runtimeSdkVersion;
  // packages/sdk/package.json — resolved relative to this file at src/plugin/
  const pkgPath = join(import.meta.dir, "..", "..", "packages", "sdk", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (typeof pkg.version === "string") {
      _runtimeSdkVersion = pkg.version;
      return pkg.version;
    }
  } catch {
    // Fall through to maw-js root package.json.
  }
  try {
    const rootPkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"));
    _runtimeSdkVersion = String(rootPkg.version ?? "0.0.0");
    return _runtimeSdkVersion;
  } catch {
    _runtimeSdkVersion = "0.0.0";
    return _runtimeSdkVersion;
  }
}

// ─── Minimal semver satisfies() ──────────────────────────────────────────────
//
// Supports the range shapes validated by the manifest parser:
//   *, N.N.N, ^N.N.N, ~N.N.N, >=N.N.N, <=N.N.N, >N.N.N, <N.N.N
// We intentionally DON'T implement full npm-style range grammar (compound
// ranges, hyphen ranges) — the parser rejects those upstream. Keeping this
// minimal avoids adding a `semver` dep. Pre-release/build metadata is
// stripped before comparison (Phase A: release-train only).
const CORE_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?(?:\+[\w.]+)?$/;

function parseCore(v: string): [number, number, number] | null {
  const m = CORE_RE.exec(v.trim());
  if (!m) return null;
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)];
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

export function satisfies(version: string, range: string): boolean {
  const v = parseCore(version);
  if (!v) return false;
  const r = range.trim();
  if (r === "*") return true;

  // Operator-prefixed (^, ~, >=, <=, >, <)
  const opMatch = /^(\^|~|>=|<=|>|<)(.+)$/.exec(r);
  const op = opMatch?.[1] ?? null;
  const rest = opMatch ? opMatch[2]! : r;
  const target = parseCore(rest);
  if (!target) return false;

  switch (op) {
    case "^": {
      // Same major. For 0.x: same minor. For 0.0.x: exact.
      if (cmp(v, target) < 0) return false;
      if (target[0] > 0) return v[0] === target[0];
      if (target[1] > 0) return v[0] === 0 && v[1] === target[1];
      return v[0] === 0 && v[1] === 0 && v[2] === target[2];
    }
    case "~": {
      // Same major.minor (or same major if no minor specified — we always have minor).
      if (cmp(v, target) < 0) return false;
      return v[0] === target[0] && v[1] === target[1];
    }
    case ">=": return cmp(v, target) >= 0;
    case "<=": return cmp(v, target) <= 0;
    case ">":  return cmp(v, target) > 0;
    case "<":  return cmp(v, target) < 0;
    default:   return cmp(v, target) === 0; // bare "1.2.3" → exact
  }
}

// ─── Actionable error formatters ─────────────────────────────────────────────

/**
 * Format the plan's canonical SDK-mismatch error.
 * Used by both the installer (pre-install) and the loader (at startup).
 */
export function formatSdkMismatchError(
  name: string,
  manifestSdk: string,
  runtimeVersion: string,
): string {
  return [
    `\x1b[31m✗\x1b[0m plugin '${name}' requires maw SDK ${manifestSdk}`,
    `  your maw: ${runtimeVersion}  (SDK ${runtimeVersion})`,
    ``,
    `  fix:`,
    `    • maw update                                    (upgrade maw)`,
    `    • maw plugin install ${name}@<old-version>      (older compat release)`,
    `    • (manual) edit plugin.json "sdk" to accept this version and rebuild`,
  ].join("\n");
}

// ─── Hash verification ───────────────────────────────────────────────────────

/**
 * Compute sha256 of a file. Returns `sha256:<hex>` to match the manifest format.
 */
export function hashFile(path: string): string {
  const buf = readFileSync(path);
  const h = createHash("sha256").update(buf).digest("hex");
  return `sha256:${h}`;
}

/**
 * Is the install a symlink (dev mode)? Checked against the plugin's top-level
 * install dir — the path that lives in ~/.maw/plugins/<name>. Per the plan,
 * symlinked installs skip hash verification (the `linked (dev)` label mode).
 */
export function isDevModeInstall(pluginDir: string): boolean {
  try {
    return lstatSync(pluginDir).isSymbolicLink();
  } catch {
    return false;
  }
}

// ─── Legacy-manifest one-shot warning ────────────────────────────────────────

let _warnedLegacy = false;
function warnLegacyOnce(count: number): void {
  if (_warnedLegacy) return;
  _warnedLegacy = true;
  if (count > 0) {
    warn(
      `${count} legacy plugin${count === 1 ? "" : "s"} loaded without artifact hash — build them to enforce integrity.`,
    );
  }
}

/** Test-only: reset cached module state (legacy-warn latch + SDK version cache). */
export function __resetDiscoverStateForTests(): void {
  _warnedLegacy = false;
  _runtimeSdkVersion = null;
}

/**
 * Scan the canonical plugin package directory and return valid packages.
 * Each subdirectory is checked for a plugin.json manifest. Plugins that
 * fail the Phase A gates (semver / hash) are refused with a loud message
 * and NOT returned — they do not enter the runtime command surface.
 */
export function discoverPackages(): LoadedPlugin[] {
  const plugins: LoadedPlugin[] = [];
  const disabled = loadConfig().disabledPlugins ?? [];
  const runtimeVer = runtimeSdkVersion();
  let legacyCount = 0;
  // #355 — aggregate mode counts for a single compact summary line instead
  // of 53 lines of per-plugin load noise. Skills-cli's test-agents run flagged
  // the per-plugin output as UX pollution. Verbose-by-default is still the
  // invariant (#343), but the right grain is SUMMARY, not per-entry.
  const modeCounts = { symlink: 0, artifact: 0, unbuilt: 0, legacy: 0 };

  for (const baseDir of scanDirs()) {
    if (!existsSync(baseDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(baseDir, { withFileTypes: true })
        .filter(e => e.isDirectory() || e.isSymbolicLink())
        .map(e => e.name);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pkgDir = join(baseDir, entry);
      let loaded: LoadedPlugin | null;
      try {
        loaded = loadManifestFromDir(pkgDir);
      } catch {
        // Invalid manifest — skip silently (noisy dirs in ~/.maw/plugins
        // that aren't plugins shouldn't spam users).
        continue;
      }
      if (!loaded) continue;

      const m = loaded.manifest;

      // Gate 1: SDK semver. Mismatch → refuse with actionable error.
      if (!satisfies(runtimeVer, m.sdk)) {
        console.warn(formatSdkMismatchError(m.name, m.sdk, runtimeVer));
        continue;
      }

      // Gate 2: artifact hash (real installs only — dev-mode skips).
      const devMode = isDevModeInstall(pkgDir);
      if (m.artifact && !devMode) {
        if (m.artifact.sha256 === null) {
          console.warn(
            `\x1b[33m⚠\x1b[0m plugin '${m.name}' is unbuilt — run \`maw plugin build\` in ${pkgDir}`,
          );
          continue;
        }
        // Resolve artifact path against the plugin dir.
        const artifactPath = join(pkgDir, m.artifact.path);
        if (!existsSync(artifactPath)) {
          console.warn(
            `\x1b[31m✗\x1b[0m plugin '${m.name}' artifact missing: ${m.artifact.path}`,
          );
          continue;
        }
        const observed = hashFile(artifactPath);
        if (observed !== m.artifact.sha256) {
          console.warn(
            `\x1b[31m✗\x1b[0m plugin '${m.name}' artifact hash mismatch — refusing to load.\n` +
            `  expected: ${m.artifact.sha256}\n` +
            `  actual:   ${observed}\n` +
            `  fix: re-install from a trusted source or re-run \`maw plugin build\``,
          );
          continue;
        }
      } else if (!m.artifact) {
        // Legacy plugin (no artifact field). Allow — but count for the one-shot
        // warning. #343b flips #341b: symlinks now count too. Dev-mode symlinks
        // are legitimately "legacy-shaped" at runtime; omitting them under-reported
        // the real legacy footprint on mixed dev machines. --quiet suppresses via
        // warn(); --verbose exposes the per-plugin mode line below.
        legacyCount++;
      }

      if (disabled.includes(m.name)) {
        loaded.disabled = true;
      }

      // Aggregate mode for post-loop summary (#355 — replace 53 per-plugin
      // lines with one compact summary). Per-plugin detail is still
      // retrievable via `maw plugin ls` when needed.
      if (devMode) modeCounts.symlink++;
      else if (m.artifact?.sha256) modeCounts.artifact++;
      else if (m.artifact) modeCounts.unbuilt++;
      else modeCounts.legacy++;

      plugins.push(loaded);
    }
  }

  // #355 — one-line summary instead of per-plugin spam. Still emits via
  // verbose() so --quiet suppresses it (verbose-by-default invariant from #343).
  verbose(() => {
    const parts: string[] = [];
    if (modeCounts.symlink) parts.push(`${modeCounts.symlink} symlink`);
    if (modeCounts.artifact) parts.push(`${modeCounts.artifact} artifact`);
    if (modeCounts.unbuilt) parts.push(`${modeCounts.unbuilt} unbuilt`);
    if (modeCounts.legacy) parts.push(`${modeCounts.legacy} legacy`);
    if (parts.length) info(`loaded ${plugins.length} plugins (${parts.join(", ")})`);
  });

  warnLegacyOnce(legacyCount);

  // Sort by weight (lower = first, default 50) — like Drupal module weight
  plugins.sort((a, b) => (a.manifest.weight ?? 50) - (b.manifest.weight ?? 50));

  return plugins;
}

/**
 * Instantiate a plugin's WASM module and call handle(ptr, len) with the context.
 * Context is JSON-encoded and written to shared memory; result is read back.
 * Hard 5-second timeout matches command-registry.ts:193.
 */
export async function invokePlugin(
  plugin: LoadedPlugin,
  ctx: InvokeContext,
): Promise<InvokeResult> {
  // Universal flags — every plugin gets these for free
  if (ctx.source === "cli") {
    const args = ctx.args as string[];
    const flag = args[0];
    const m = plugin.manifest;

    // -v / --version — show plugin metadata
    if (flag === "-v" || flag === "--version" || flag === "-version") {
      const surfaces = [
        m.cli ? `cli:${m.cli.command}` : null,
        m.api ? `api:${m.api.path}` : null,
        m.hooks ? "hooks" : null,
        m.transport?.peer ? "peer" : null,
      ].filter(Boolean).join(", ");
      return {
        ok: true,
        output: `${m.name} v${m.version} (${plugin.kind}, weight:${m.weight ?? 50})\n  ${m.description || ""}\n  surfaces: ${surfaces}\n  dir: ${plugin.dir}`,
      };
    }

    // -h / --help — show usage + flags + surfaces
    if (flag === "-h" || flag === "--help" || flag === "-help") {
      const lines: string[] = [];
      lines.push(`${m.name} v${m.version}`);
      if (m.description) lines.push(`  ${m.description}`);
      lines.push("");
      if (m.cli?.help) lines.push(`  usage: ${m.cli.help}`);
      else if (m.cli) lines.push(`  usage: maw ${m.cli.command}`);
      if (m.cli?.aliases?.length) lines.push(`  aliases: ${m.cli.aliases.join(", ")}`);
      if (m.cli?.flags) {
        lines.push("  flags:");
        for (const [k, v] of Object.entries(m.cli.flags)) lines.push(`    ${k.padEnd(20)} ${v}`);
      }
      lines.push("");
      lines.push("  surfaces:");
      if (m.cli) lines.push(`    cli: maw ${m.cli.command}`);
      if (m.api) lines.push(`    api: ${m.api.methods.join("/")} ${m.api.path}`);
      if (m.transport?.peer) lines.push(`    peer: maw hey plugin:${m.name}`);
      if (m.hooks) lines.push(`    hooks: ${Object.keys(m.hooks).join(", ")}`);
      lines.push(`\n  dir: ${plugin.dir}`);
      return { ok: true, output: lines.join("\n") };
    }
  }

  // TS plugins — import and call handler directly (full access).
  //
  // NOTE: we deliberately do NOT monkey-patch process.exit anymore. The old
  // `process.exit → throw Error("exit")` patch swallowed real error stacks
  // and made plugin crashes opaque (sdk-consumer's Round 1 complaint). If a
  // plugin calls process.exit() it's now fatal to the host — which is the
  // honest behavior for Phase A (no sandbox).
  if (plugin.kind === "ts" && plugin.entryPath) {
    try {
      const mod = await import(plugin.entryPath);
      const handler = mod.default || mod.handler;
      if (!handler) return { ok: false, error: "TS plugin has no default export or handler" };

      const result = await handler(ctx);
      if (result && typeof result === "object" && "ok" in result) return result;
      return { ok: true };
    } catch (err: any) {
      // Preserve stack so Bun's source maps can resolve plugin frames.
      return { ok: false, error: err.stack || err.message };
    }
  }

  // WASM plugins — instantiate and call handle(ptr, len) in sandbox
  let wasmBytes: Uint8Array;
  try {
    wasmBytes = readFileSync(plugin.wasmPath);
  } catch (err: any) {
    return { ok: false, error: `failed to read wasm: ${err.message}` };
  }

  // Compile
  let mod: WebAssembly.Module;
  try {
    mod = new WebAssembly.Module(wasmBytes);
  } catch (err: any) {
    return { ok: false, error: `wasm compile error: ${err.message}` };
  }

  const exportNames = WebAssembly.Module.exports(mod).map(
    (e: { name: string }) => e.name,
  );
  if (!exportNames.includes("handle") || !exportNames.includes("memory")) {
    return { ok: false, error: "wasm missing required handle+memory exports" };
  }

  // Late-binding refs (chicken-and-egg with memory/alloc exports)
  let wasmMemory!: WebAssembly.Memory;
  let wasmAlloc!: (size: number) => number;

  const bridge = buildImportObject(
    () => wasmMemory,
    () => wasmAlloc,
    { memoryMaxPages: WASM_MEMORY_MAX_PAGES },
  );

  let instance: WebAssembly.Instance;
  try {
    instance = new WebAssembly.Instance(mod, bridge);
  } catch (err: any) {
    return { ok: false, error: `wasm instantiation failed: ${err.message}` };
  }

  wasmMemory = instance.exports.memory as WebAssembly.Memory;
  wasmAlloc =
    (instance.exports.maw_alloc as (size: number) => number) ??
    bridge.env.maw_alloc;

  const handle = instance.exports.handle as (ptr: number, len: number) => number;

  const exec = (async (): Promise<InvokeResult> => {
    // Pre-warm identity + federation caches (best-effort, won't throw)
    await preCacheBridge(bridge);

    // Write JSON-encoded context into shared memory
    const json = JSON.stringify(ctx);
    const bytes = textEncoder.encode(json);
    const argPtr =
      (instance.exports.maw_alloc as Function)?.(bytes.length) ?? 0;
    new Uint8Array(wasmMemory.buffer).set(bytes, argPtr);

    // Invoke handle(ptr, len) — matches command-registry.ts protocol
    const resultPtr = handle(argPtr, bytes.length);

    if (resultPtr > 0) {
      const view = new DataView(wasmMemory.buffer);
      const len = view.getUint32(resultPtr, true);
      if (len > 0 && len < 1_000_000) {
        // Length-prefixed protocol (u32 LE + UTF-8 payload)
        const output = readString(wasmMemory, resultPtr + 4, len);
        return { ok: true, ...(output ? { output } : {}) };
      }
      // Null-terminated fallback for legacy modules
      const raw = new Uint8Array(wasmMemory.buffer);
      let end = resultPtr;
      while (end < raw.length && raw[end] !== 0) end++;
      const output = new TextDecoder().decode(raw.slice(resultPtr, end));
      return { ok: true, ...(output ? { output } : {}) };
    }

    return { ok: true };
  })();

  // 5-second hard deadline — matches command-registry.ts:193
  const timeoutGuard = new Promise<InvokeResult>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            `[wasm-safety] timed out after ${PLUGIN_INVOKE_TIMEOUT_MS / 1000}s`,
          ),
        ),
      PLUGIN_INVOKE_TIMEOUT_MS,
    ),
  );

  try {
    return await Promise.race([exec, timeoutGuard]);
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
