/** Runtime helpers: SDK version resolution, hash verification, dev-mode detection. */

import { createHash } from "crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { warn } from "../cli/verbosity";
import { mawDataPath, mawStatePath } from "../core/xdg";

// JSON import inlined at build time — survives bundling (dist/maw).
// Source mode: resolved on load. Bundled mode: Bun embeds the JSON.
// Either way runtimeSdkVersion() returns the real value, never "0.0.0".
// See #543 — previous fs-read approach broke in dist/maw because
// import.meta.dir walks to a path that doesn't exist post-bundle.
import sdkPkg from "../../packages/sdk/package.json" with { type: "json" };

// Scan the global plugin dir plus any repo-local `.maw/plugins` dirs found by
// walking up from cwd. Resolved at call time so tests and per-command cwd
// routing can override roots.
export function discoverLocalPluginDirs(cwd = process.cwd()): string[] {
  const dirs: string[] = [];
  let dir = resolve(cwd);
  for (let i = 0; i < 32; i += 1) {
    const pluginsDir = join(dir, ".maw", "plugins");
    if (existsSync(pluginsDir)) dirs.push(pluginsDir);
    if (existsSync(join(dir, ".maw-root"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

export function scanDirs(cwd = process.cwd()): string[] {
  const pluginDirs = [...discoverLocalPluginDirs(cwd), process.env.MAW_PLUGINS_DIR || mawDataPath("plugins")];
  return [...new Set(pluginDirs)];
}

/** Runtime SDK version — sourced from @maw-js/sdk package.json (build-inlined). */
let _runtimeSdkVersion: string | null = null;
export function runtimeSdkVersion(): string {
  if (_runtimeSdkVersion) return _runtimeSdkVersion;
  const v = typeof sdkPkg.version === "string" ? sdkPkg.version : "0.0.0";
  _runtimeSdkVersion = v;
  return v;
}

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

const WARN_THROTTLE_MS = 3_600_000; // 1 hour

// Resolved lazily so MAW_WARN_STATE_FILE env var can redirect the path (e.g. in tests).
function warnStatePath(): string {
  return process.env.MAW_WARN_STATE_FILE
    || mawStatePath("session-warnings.state");
}

// Test-only bypass: set by __resetDiscoverStateForTests to skip the hourly
// throttle without touching the real state file on disk.
let _bypassWarnThrottle = false;

function shouldShowLegacyWarning(): boolean {
  if (_bypassWarnThrottle) return true;
  try {
    const stateFile = warnStatePath();
    if (!existsSync(stateFile)) return true;
    const raw = readFileSync(stateFile, "utf8");
    const state = JSON.parse(raw) as { "legacy-plugin-warning"?: { lastShownMs?: number } };
    const lastShownMs = state["legacy-plugin-warning"]?.lastShownMs ?? 0;
    return Date.now() - lastShownMs > WARN_THROTTLE_MS;
  } catch {
    return true; // corrupt state — show the warning
  }
}

function markLegacyWarningShown(): void {
  if (_bypassWarnThrottle) return; // don't persist during tests
  try {
    const stateFile = warnStatePath();
    const dir = join(stateFile, "..");
    mkdirSync(dir, { recursive: true });
    let state: Record<string, unknown> = {};
    if (existsSync(stateFile)) {
      try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { /* corrupt — start fresh */ }
    }
    state["legacy-plugin-warning"] = { lastShownMs: Date.now() };
    // lgtm[js/file-system-race] — PRIVATE-PATH: plugin throttle state under user state dir, see docs/security/file-system-race-stance.md
    writeFileSync(stateFile, JSON.stringify(state), "utf8");
  } catch { /* non-critical — ignore write errors */ }
}

let _warnedLegacy = false;
export function warnLegacyOnce(count: number): void {
  if (_warnedLegacy) return;
  _warnedLegacy = true;
  if (count > 0 && shouldShowLegacyWarning()) {
    warn(
      `${count} legacy plugin${count === 1 ? "" : "s"} loaded without artifact hash — build them to enforce integrity.`,
    );
    markLegacyWarningShown();
  }
}

/** Test-only: reset cached module state (legacy-warn latch + SDK version cache). */
export function __resetDiscoverStateForTests(): void {
  _warnedLegacy = false;
  _bypassWarnThrottle = true; // skip hourly throttle in test runs
  _runtimeSdkVersion = null;
}
