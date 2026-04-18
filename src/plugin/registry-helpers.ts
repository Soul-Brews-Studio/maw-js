/** Runtime helpers: SDK version resolution, hash verification, dev-mode detection. */

import { createHash } from "crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { warn } from "../cli/verbosity";

// JSON import inlined at build time — survives bundling (dist/maw).
// Source mode: resolved on load. Bundled mode: Bun embeds the JSON.
// Either way runtimeSdkVersion() returns the real value, never "0.0.0".
// See #543 — previous fs-read approach broke in dist/maw because
// import.meta.dir walks to a path that doesn't exist post-bundle.
import sdkPkg from "../../packages/sdk/package.json" with { type: "json" };

// Single scan dir — everything lives in ~/.maw/plugins/ (or MAW_PLUGINS_DIR
// if set). Resolved at call time so tests can override the root.
export function scanDirs(): string[] {
  return [process.env.MAW_PLUGINS_DIR || join(homedir(), ".maw", "plugins")];
}

/** Runtime SDK version — sourced from @maw/sdk package.json (build-inlined). */
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
    || join(homedir(), ".config", "maw", "session-warnings.state");
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
