/**
 * #1339 Option E — make `maw-js` resolvable from any installed plugin.
 *
 * After `maw plugin install` (or on every boot), ensure
 *   <installRoot>/node_modules/maw-js
 * exists as a symlink to the running maw-js source root. Plugins under
 * <installRoot>/<name>/ then resolve `import "maw-js/..."` via the standard
 * node_modules walk-up.
 *
 * ── Why this is needed ──────────────────────────────────────────────────────
 * Per the Layer 2 trace in #1339 (sila@oracle-world, 2026-05-14): plugins
 * installed into ~/.maw/plugins/<name>/ import subpaths declared in
 * maw-js's package.json#exports (e.g. `maw-js/cli/parse-args`). Bun resolves
 * the subpath fine — but ONLY if it can first resolve `maw-js` itself, which
 * requires `node_modules/maw-js` somewhere in the ancestor walk from the
 * plugin file. A global `bun install -g maw-js` lands the package under
 * `~/.bun/install/global/node_modules/maw-js/` — NOT in any ancestor of
 * `~/.maw/plugins/<name>/`. Walk-up fails. Plugin import errors. UX dies.
 *
 * ── How this fix differs from #641's per-plugin link ────────────────────────
 * `src/commands/plugins/plugin/install-handlers.ts:ensurePluginMawJsLink`
 * writes `<srcDir>/node_modules/maw-js` INSIDE each linked plugin source — and
 * runs only on `--link` installs (dev workflow). Tarball / URL / peer / monorepo
 * / github installs never touch it, and `<srcDir>` is the operator's source
 * tree, not `~/.maw/plugins/<name>/`. So #641 doesn't cover the Layer 2 case.
 *
 * This helper writes ONE shared link at the install-root parent
 * (`~/.maw/plugins/node_modules/maw-js`) — covers every plugin under it,
 * regardless of how it was installed.
 *
 * ── Resolution chain for the maw-js root ────────────────────────────────────
 *   1. `$MAW_JS_PATH` env override — matches existing #641 convention so
 *      tests and unusual layouts have a single env knob.
 *   2. Walk up from this file (`src/plugin/`) two levels → the maw-js
 *      repo root (the one with package.json `name: "maw-js"`).
 *
 * Bun.resolveSync("maw-js") is NOT used — the WHOLE POINT is that "maw-js"
 * isn't resolvable from arbitrary contexts; the running CLI's own location
 * is the only reliable anchor.
 *
 * ── Invariants ──────────────────────────────────────────────────────────────
 *   • Idempotent (safe to call N times — returns `changed: false` on no-op).
 *   • Silent on no-op (caller decides whether to log).
 *   • Tolerates broken symlinks gracefully (removes + recreates dangling ones).
 *   • Does NOT clobber a wrong-but-existing symlink pointing elsewhere
 *     (returns `changed: false` with a `reason` so callers can surface).
 *   • Never throws on permission / fs errors — returns a `reason` instead.
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import { installRoot } from "../commands/plugins/plugin/install-source-detect";

/** Resolve the running maw-js source root. */
function resolveMawJsRoot(): string {
  if (process.env.MAW_JS_PATH) return process.env.MAW_JS_PATH;
  // this file: <mawJsRoot>/src/plugin/ensure-maw-js-resolvable.ts
  return resolve(import.meta.dir, "..", "..");
}

export interface EnsureResult {
  changed: boolean;
  /** Short human-readable reason — caller may log on verbose. */
  reason: string;
  /** Absolute path of the symlink (whether or not it was created). */
  linkPath: string;
  /** Absolute path of the maw-js root the link points (or would point) at. */
  target: string;
}

/**
 * Ensure `<installRoot>/node_modules/maw-js` is a symlink to the running
 * maw-js source root. See module header for full rationale.
 */
export function ensureMawJsResolvable(): EnsureResult {
  const mawJsRoot = resolveMawJsRoot();
  const nodeModulesDir = join(installRoot(), "node_modules");
  const linkPath = join(nodeModulesDir, "maw-js");

  if (!existsSync(mawJsRoot)) {
    return {
      changed: false,
      reason: `maw-js root not found at ${mawJsRoot}`,
      linkPath,
      target: mawJsRoot,
    };
  }

  // Check the existing link via lstat (existsSync follows broken symlinks
  // to false — we want to detect a dangling symlink and replace it).
  let existing: import("fs").Stats | undefined;
  try { existing = lstatSync(linkPath); } catch { /* absent */ }

  if (existing) {
    if (existing.isSymbolicLink()) {
      let linkTarget: string;
      try {
        linkTarget = readlinkSync(linkPath);
      } catch {
        // unreadable symlink — replace.
        try { unlinkSync(linkPath); } catch { /* leave alone */ }
        return tryLink(nodeModulesDir, linkPath, mawJsRoot, "replaced unreadable symlink");
      }
      const resolvedTarget = resolve(nodeModulesDir, linkTarget);
      if (resolvedTarget === mawJsRoot) {
        return {
          changed: false,
          reason: "symlink already correct",
          linkPath,
          target: mawJsRoot,
        };
      }
      // Dangling? (target absent on disk) → safe to replace.
      if (!existsSync(linkPath)) {
        try { unlinkSync(linkPath); } catch { /* leave alone */ }
        return tryLink(nodeModulesDir, linkPath, mawJsRoot, `replaced dangling symlink (was → ${linkTarget})`);
      }
      // Live symlink to a DIFFERENT location — operator put it there or a
      // prior maw-js install owns it. Do not clobber (#1339 spec invariant).
      return {
        changed: false,
        reason: `symlink exists but points to ${resolvedTarget}; leave alone (manual fix needed)`,
        linkPath,
        target: mawJsRoot,
      };
    }
    // Real file or directory at linkPath — operator intent, leave alone.
    return {
      changed: false,
      reason: `${linkPath} is not a symlink; leave alone`,
      linkPath,
      target: mawJsRoot,
    };
  }

  return tryLink(nodeModulesDir, linkPath, mawJsRoot, `linked ${linkPath} → ${mawJsRoot}`);
}

function tryLink(
  nodeModulesDir: string,
  linkPath: string,
  mawJsRoot: string,
  successReason: string,
): EnsureResult {
  try {
    mkdirSync(nodeModulesDir, { recursive: true });
    symlinkSync(mawJsRoot, linkPath, "dir");
    return { changed: true, reason: successReason, linkPath, target: mawJsRoot };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      changed: false,
      reason: `failed to create symlink: ${msg}`,
      linkPath,
      target: mawJsRoot,
    };
  }
}
