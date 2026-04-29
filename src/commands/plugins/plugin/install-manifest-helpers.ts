/**
 * install-impl seam: manifest reading + success printing helpers.
 */

import type { PluginManifest } from "../../../plugin/types";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { parseManifest } from "../../../plugin/manifest";
import { runtimeSdkVersion } from "../../../plugin/registry";

/**
 * #864 — Resolve the plugin root inside an extracted staging dir.
 *
 * `maw plugin build` produces flat tarballs (plugin.json at root). But
 * GitHub-archive tarballs (`github:OWNER/REPO#REF` registry sources, used by
 * shellenv/bg/rename/park) extract with a wrapping `<repo>-<ref>/` directory,
 * and npm tarballs likewise wrap in `package/`. Both leave plugin.json one
 * level down, breaking root-only manifest discovery.
 *
 * Walks at most one level: if plugin.json exists at root, returns root; else
 * if root contains exactly one entry — a directory — with plugin.json inside,
 * returns that subdir; else returns null. The extractTarball() path-traversal
 * guard ensures every entry lives under the staging dir, so walking one level
 * is safe.
 */
export function findPluginRoot(stagingDir: string): string | null {
  if (existsSync(join(stagingDir, "plugin.json"))) return stagingDir;
  let entries: string[];
  try { entries = readdirSync(stagingDir); } catch { return null; }
  if (entries.length !== 1) return null;
  const inner = join(stagingDir, entries[0]!);
  try { if (!statSync(inner).isDirectory()) return null; } catch { return null; }
  if (existsSync(join(inner, "plugin.json"))) return inner;
  return null;
}

/**
 * Resolve the plugin root inside an extracted monorepo staging dir
 * (maw-plugin-registry#2). The registry repo's tarball, fetched via the
 * `monorepo:plugins/<name>@<tag>` source format, is wrapped by github in
 * `<repo>-<tag>/` and contains the FULL repo at that tag — so the plugin
 * doesn't live at the root, it lives under a known subpath
 * (typically `plugins/<name>/`).
 *
 * Walk: optional wrapper-dir descent (matching findPluginRoot's one-level
 * walk), then descend into `subpath`. Returns null if no `plugin.json` is
 * found at the resolved location.
 *
 * Path-traversal is gated upstream by `extractTarball`'s entry list check;
 * we still refuse `..` segments in the parsed subpath (parseMonorepoRef).
 */
export function findMonorepoPluginRoot(stagingDir: string, subpath: string): string | null {
  // First try: subpath relative to the staging dir directly. Local-tarball
  // fixtures and any tarball whose entries weren't wrapped in a top-level
  // dir hit this path.
  const direct = join(stagingDir, subpath);
  if (existsSync(join(direct, "plugin.json"))) return direct;

  // Then: github-archive wrap style — `<repo>-<tag>/<subpath>/`. Walk one
  // level into the lone top-level dir and retry. We don't gate on plugin.json
  // at the staging root because the monorepo root NEVER has plugin.json — the
  // root is the repo, plugins live under <subpath>.
  let entries: string[];
  try { entries = readdirSync(stagingDir); } catch { return null; }
  if (entries.length !== 1) return null;
  const inner = join(stagingDir, entries[0]!);
  try {
    if (!statSync(inner).isDirectory()) return null;
  } catch { return null; }
  const wrapped = join(inner, subpath);
  if (existsSync(join(wrapped, "plugin.json"))) return wrapped;
  return null;
}

/**
 * Read + parse plugin.json from an unpacked dir. Returns null + logs if missing.
 */
export function readManifest(dir: string): PluginManifest | null {
  const manifestPath = join(dir, "plugin.json");
  if (!existsSync(manifestPath)) {
    console.error(`\x1b[31m✗\x1b[0m no plugin.json at ${dir}`);
    return null;
  }
  try {
    return parseManifest(readFileSync(manifestPath, "utf8"), dir);
  } catch (e: any) {
    console.error(`\x1b[31m✗\x1b[0m invalid plugin.json: ${e.message}`);
    return null;
  }
}

/** Short sha256 prefix for the label, e.g. "abc1234" from "sha256:abc1234def…". */
export function shortHash(sha256: string): string {
  const idx = sha256.indexOf(":");
  const hex = idx === -1 ? sha256 : sha256.slice(idx + 1);
  return hex.slice(0, 7);
}

/** Print the Phase A success label block. */
export function printInstallSuccess(
  manifest: PluginManifest,
  dest: string,
  mode: "linked (dev)" | { sha256: string },
  sourceNote?: string,
): void {
  const runtime = runtimeSdkVersion();
  const caps =
    manifest.capabilities && manifest.capabilities.length
      ? manifest.capabilities.join(", ")
      : "(none)";
  const modeLabel =
    typeof mode === "string" ? mode : `installed (sha256:${shortHash(mode.sha256)}…)`;
  const lines = [
    `\x1b[32m✓\x1b[0m ${manifest.name}@${manifest.version} installed${sourceNote ? " " + sourceNote : ""}`,
    `  sdk: ${manifest.sdk} ✓ (maw ${runtime})`,
    `  capabilities: ${caps}`,
    `  mode: ${modeLabel}`,
    `  dir: ${dest}`,
    `try: maw ${manifest.cli?.command ?? manifest.name}`,
  ];
  console.log(lines.join("\n"));
}
