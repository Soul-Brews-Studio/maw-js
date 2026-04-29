/**
 * install-impl seam: per-source-type install handlers.
 * installFromDir / installFromTarball / installFromUrl
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { formatSdkMismatchError, hashFile, runtimeSdkVersion, satisfies } from "../../../plugin/registry";
import { installRoot, removeExisting, type GithubRef } from "./install-source-detect";
import { extractTarball, downloadTarball, verifyArtifactHash, verifyArtifactHashAgainst, isSourcePluginManifest } from "./install-extraction";
import { findPluginRoot, findMonorepoPluginRoot, readManifest, printInstallSuccess } from "./install-manifest-helpers";
import { readLock, recordInstall } from "./lock";
import { createHash } from "crypto";

/**
 * #404 — preserve category across replace. Category is derived from `weight`
 * (core <10, standard <50, extra >=50). When `install --link` replaces a
 * plugin whose new plugin.json omits `weight`, the default-50 would silently
 * reclassify it. Before removing the prior install we capture its weight
 * into ~/.maw/plugins/.overrides.json, where the loader picks it up so the
 * category is preserved. An explicit `weight` on the incoming manifest
 * always wins; an `explicit` weight (e.g. --category flag) always wins.
 */
function preserveWeightOnReplace(
  name: string, incoming: number | undefined, dest: string, explicit?: number,
): void {
  const path = join(installRoot(), ".overrides.json");
  let overrides: Record<string, number> = {};
  try { overrides = JSON.parse(readFileSync(path, "utf8")); } catch { /* absent or corrupt */ }
  let effective = explicit;
  if (effective === undefined && incoming === undefined) {
    try { effective = readManifest(dest)?.weight; } catch { /* no prior manifest */ }
  }
  if (effective !== undefined) overrides[name] = effective;
  else if (incoming !== undefined) delete overrides[name]; // incoming is explicit → drop stale override
  writeFileSync(path, JSON.stringify(overrides, null, 2) + "\n", "utf8");
}

/**
 * #403 Bug — refuse to overwrite an existing install unless --force.
 * Surfaces what would be replaced (existing target + incoming source) so
 * the operator can decide. Multi-agent fleets break silently when one
 * agent overwrites a working symlink another depends on; this gate
 * prevents that without giving up the override path.
 */
function refuseExistingInstall(dest: string, incoming: string, name: string): never {
  let existingNote = dest;
  try {
    const st = lstatSync(dest);
    if (st.isSymbolicLink()) existingNote = `${dest} → ${readlinkSync(dest)}`;
    else if (st.isDirectory()) existingNote = `${dest} (real directory)`;
  } catch { /* fall through with bare path */ }
  throw new Error(
    `refusing to overwrite plugin '${name}':\n` +
    `  existing: ${existingNote}\n` +
    `  incoming: ${incoming}\n` +
    `  pass --force to overwrite (will replace the existing install silently)`
  );
}

/**
 * #641 — Auto-link `maw-js` into the plugin source's `node_modules/` on
 * `--link` install so `import "maw-js/sdk"` resolves without per-repo setup.sh.
 *
 * Resolution chain for the maw-js root:
 *   1. `$MAW_JS_PATH` env override (used by tests + unusual layouts)
 *   2. Walk up from this file (src/commands/plugins/plugin/) four levels →
 *      the running maw-js repo root. That's where `package.json#name="maw-js"`
 *      with `exports["./sdk"]` lives, which is what bun needs to resolve.
 *
 * Idempotent: if `<srcDir>/node_modules/maw-js` is already a symlink to the
 * resolved root, no-op. If it points elsewhere, replace. If it's a real
 * directory or file, leave it alone — the operator put something there
 * intentionally.
 */
function resolveMawJsRoot(): string {
  if (process.env.MAW_JS_PATH) return process.env.MAW_JS_PATH;
  // this file: <mawJsRoot>/src/commands/plugins/plugin/install-handlers.ts
  return resolve(import.meta.dir, "..", "..", "..", "..");
}

export function ensurePluginMawJsLink(srcDir: string): void {
  const mawJsRoot = resolveMawJsRoot();
  const nodeModulesDir = join(srcDir, "node_modules");
  const target = join(nodeModulesDir, "maw-js");

  let existing: import("fs").Stats | undefined;
  try { existing = lstatSync(target); } catch { /* absent */ }

  if (existing) {
    if (existing.isSymbolicLink()) {
      try {
        const linkTarget = readlinkSync(target);
        const resolved = resolve(nodeModulesDir, linkTarget);
        if (resolved === mawJsRoot) return; // already correct
      } catch { /* dangling — fall through to replace */ }
      unlinkSync(target);
    } else {
      // Real directory or file — respect operator intent, don't clobber.
      return;
    }
  }

  mkdirSync(nodeModulesDir, { recursive: true });
  symlinkSync(mawJsRoot, target, "dir");
}

export async function installFromDir(
  srcDir: string,
  opts: { force?: boolean; weight?: number } = {},
): Promise<void> {
  if (!existsSync(srcDir)) {
    throw new Error(`source not found: ${srcDir}`);
  }
  if (!statSync(srcDir).isDirectory()) {
    throw new Error(`not a directory: ${srcDir}`);
  }
  const manifest = readManifest(srcDir);
  if (!manifest) throw new Error("failed to read plugin manifest");

  // Semver gate — before symlinking, so a broken plugin never lands.
  const runtime = runtimeSdkVersion();
  if (!satisfies(runtime, manifest!.sdk)) {
    throw new Error(formatSdkMismatchError(manifest!.name, manifest!.sdk, runtime));
  }

  const dest = join(installRoot(), manifest!.name);

  // #403 — refuse silent overwrite unless --force.
  if (existsSync(dest) && !opts.force) {
    refuseExistingInstall(dest, srcDir, manifest!.name);
  }

  // #404 — capture prior weight before the replace so category survives.
  const replacing = existsSync(dest);
  if (replacing || opts.weight !== undefined) {
    preserveWeightOnReplace(manifest!.name, manifest!.weight, dest, opts.weight);
  }

  removeExisting(dest);
  symlinkSync(srcDir, dest, "dir");

  // #641 — arrange `maw-js/sdk` resolution from the plugin's perspective so
  // the author never has to run a per-repo setup.sh.
  ensurePluginMawJsLink(srcDir);

  // #680 ask #1 — persist lock entry for --link installs. sha256 is of the
  // plugin.json content (stable identity; the symlinked source isn't a
  // sealed artifact so there's no tarball hash to record).
  const absSrc = resolve(srcDir);
  const pluginJsonBytes = readFileSync(join(absSrc, "plugin.json"));
  const sha = `sha256:${createHash("sha256").update(pluginJsonBytes).digest("hex")}`;
  recordInstall({
    name: manifest!.name,
    version: manifest!.version,
    sha256: sha,
    source: `link:${absSrc}`,
    linked: true,
  });

  printInstallSuccess(manifest!, dest, "linked (dev)");
}

export async function installFromTarball(
  tarballPath: string,
  opts: { source: string; force?: boolean; weight?: number; pin?: boolean; subpath?: string },
): Promise<void> {
  if (!existsSync(tarballPath)) {
    throw new Error(`tarball not found: ${tarballPath}`);
  }

  // Extract into a staging dir so we can read the manifest + verify hash
  // before any ~/.maw/plugins/ mutation.
  const staging = mkdtempSync(join(tmpdir(), "maw-install-"));
  const extractResult = extractTarball(tarballPath, staging);
  if (!extractResult.ok) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(extractResult.error);
  }

  // #864 — github-archive and npm tarballs wrap contents in a single top-level
  // directory (`<repo>-<ref>/` or `package/`). Walk one level if needed.
  // monorepo: source format (registry#2) — additionally walk into the declared
  // subpath (e.g. plugins/<name>/) inside the wrapper to reach the plugin.
  const pluginRoot = opts.subpath
    ? findMonorepoPluginRoot(staging, opts.subpath)
    : findPluginRoot(staging);
  if (!pluginRoot) {
    rmSync(staging, { recursive: true, force: true });
    if (opts.subpath) {
      throw new Error(
        `failed to read plugin manifest: no plugin.json at subpath '${opts.subpath}' inside ${staging} (or its single top-level wrapper dir)`,
      );
    }
    throw new Error(`failed to read plugin manifest: no plugin.json at ${staging} or in single top-level subdir`);
  }

  const manifest = readManifest(pluginRoot);
  if (!manifest) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error("failed to read plugin manifest");
  }

  const runtime = runtimeSdkVersion();
  if (!satisfies(runtime, manifest!.sdk)) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(formatSdkMismatchError(manifest!.name, manifest!.sdk, runtime));
  }

  // Defense-in-depth fencepost (#487 §8 Phase 1): manifest-embedded hash still
  // catches transport corruption and hand-edited tarballs before we touch
  // ~/.maw/plugins. It is NOT the adversarial check — plugins.lock is.
  const selfHashResult = verifyArtifactHash(pluginRoot, manifest!);
  if (!selfHashResult.ok) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(selfHashResult.error);
  }

  // Registry-pinned verification (#487 Option A, #680 ask 2). The expected
  // hash comes from the operator-curated lockfile, not the tarball itself —
  // this is what closes the MITM / CDN-swap threat.
  //
  // Gate behavior (#680 ask 2):
  //   • No entry for <name>  → proceed (writer agent, #680 ask 1, persists).
  //   • Entry + sha matches  → proceed.
  //   • Entry + sha differs  → refuse unless --force OR --pin.
  //       --force: override, re-write lock to new sha.
  //       --pin:   re-pin, same effect — semantically an explicit re-trust.
  let lock;
  try {
    lock = readLock();
  } catch (e: any) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  const pinned = lock.plugins[manifest!.name];
  if (!pinned) {
    void opts.pin;
  } else {
    if (pinned.version !== manifest!.version) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error(
        `plugin '${manifest!.name}' version mismatch: plugins.lock=${pinned.version} tarball=${manifest!.version}`,
      );
    }
    const pinnedResult = verifyArtifactHashAgainst(pluginRoot, manifest!, pinned.sha256);
    if (!pinnedResult.ok) {
      if (!opts.force && !opts.pin) {
        rmSync(staging, { recursive: true, force: true });
        const observed = manifest!.artifact?.sha256 ?? "(unknown)";
        throw new Error(
          `plugin '${manifest!.name}' sha256 mismatch — refusing to install.\n` +
          `  plugins.lock: ${pinned.sha256}\n` +
          `  tarball:      ${observed}\n` +
          `  --force to override (updates lock), --pin to re-pin`,
        );
      }
      // --force / --pin: operator re-trusted; recordInstall() below overwrites.
    }
  }

  // All gates passed — move staging into the install root.
  const dest = join(installRoot(), manifest!.name);

  // #403 — refuse silent overwrite unless --force.
  if (existsSync(dest) && !opts.force) {
    rmSync(staging, { recursive: true, force: true });
    refuseExistingInstall(dest, opts.source, manifest!.name);
  }

  // #404 — capture prior weight before the replace so category survives.
  if (existsSync(dest) || opts.weight !== undefined) {
    preserveWeightOnReplace(manifest!.name, manifest!.weight, dest, opts.weight);
  }

  removeExisting(dest);
  // Use rename when the staging dir is on the same fs; otherwise copy-then-rm.
  // #864 — rename pluginRoot (not staging): when github/npm wrapped in a
  // single subdir, pluginRoot points at the subdir and staging is its parent.
  try {
    const { renameSync } = require("fs");
    renameSync(pluginRoot, dest);
  } catch {
    // Cross-device fallback (rare). Fall back to cp -a then rm -rf.
    spawnSync("cp", ["-a", pluginRoot + "/.", dest], { encoding: "utf8" });
  }
  // Clean up the staging tmpdir. When pluginRoot === staging this no-ops
  // (already moved); when pluginRoot was a subdir, staging is now empty
  // (or has the cp leftovers in the cross-device case).
  rmSync(staging, { recursive: true, force: true });

  // #680 — persist lock entry on every successful tarball install. TOFU on
  // first install; overwrites on --force/--pin re-trust.
  //
  // #874 path A.3 — source plugins have no `artifact.sha256` to record. Hash
  // the entry file's bytes instead so plugins.lock has a stable identity to
  // verify against on subsequent installs. The entry file IS the artifact for
  // source plugins (Bun executes .ts/.js source directly).
  //
  // #896 — defensive: prefer source-plugin path when manifest is source-shaped
  // (covers no-artifact AND half-built artifact.sha256=null). Avoids recording
  // a null sha into the lockfile when the manifest is mid-build but ships a
  // valid entry.
  const recordedSha = isSourcePluginManifest(manifest!)
    ? hashFile(join(dest, manifest!.entry!))
    : manifest!.artifact?.sha256
      ?? hashFile(join(dest, manifest!.entry!));
  recordInstall({
    name: manifest!.name,
    version: manifest!.version,
    sha256: recordedSha,
    source: opts.source,
  });

  const sourceNote = opts.source.startsWith("http") ? `from ${opts.source}` : "";
  printInstallSuccess(
    manifest!,
    dest,
    { sha256: recordedSha },
    sourceNote || undefined,
  );
}

export async function installFromUrl(
  url: string,
  opts: { force?: boolean; weight?: number; pin?: boolean } = {},
): Promise<void> {
  const dl = await downloadTarball(url);
  if (!dl.ok) {
    throw new Error(dl.error);
  }
  try {
    await installFromTarball(dl.path, { source: url, force: opts.force, weight: opts.weight, pin: opts.pin });
  } finally {
    // Clean up the downloaded temp file.
    try {
      rmSync(join(dl.path, ".."), { recursive: true, force: true });
    } catch {
      // Non-fatal.
    }
  }
}

/**
 * Default monorepo registry repo slug. The maw-plugin-registry monorepo
 * (registry#2) hosts community plugins under `plugins/<name>/`. Override
 * via `MAW_MONOREPO_REGISTRY_REPO` for forks / mirrors / tests.
 *
 * The base GitHub host is also overrideable via `MAW_MONOREPO_BASE_URL`
 * (default `https://github.com`) so tests can serve fixture tarballs from
 * a local HTTP server without monkey-patching fetch.
 */
const DEFAULT_MONOREPO_REPO = "Soul-Brews-Studio/maw-plugin-registry";
const DEFAULT_MONOREPO_BASE_URL = "https://github.com";

export function monorepoRepoSlug(): string {
  return process.env.MAW_MONOREPO_REGISTRY_REPO || DEFAULT_MONOREPO_REPO;
}

export function monorepoTarballUrl(tag: string, repo?: string): string {
  const r = repo || monorepoRepoSlug();
  const base = process.env.MAW_MONOREPO_BASE_URL || DEFAULT_MONOREPO_BASE_URL;
  return `${base}/${r}/archive/refs/tags/${tag}.tar.gz`;
}

/**
 * Install a plugin from the maw-plugin-registry monorepo (registry#2).
 *
 * Source format: `monorepo:plugins/<name>@<tag>` — the subpath identifies
 * the plugin dir within the registry repo, the tag pins the registry repo
 * version. Resolution downloads the github archive of the registry repo at
 * `<tag>`, then walks into `<repo>-<tag>/<subpath>/` to reach the plugin.
 *
 * Reuses the existing installFromTarball flow (sdk gate, sha256 verify,
 * plugins.lock, --pin/--force semantics) — the only delta is the wrapper +
 * subpath walk performed in findMonorepoPluginRoot.
 */
/**
 * Default GitHub host for `installFromGithub` archive URLs. Override via
 * `MAW_GITHUB_BASE_URL` for tests / on-prem GitHub Enterprise / mirrors —
 * mirrors the `MAW_MONOREPO_BASE_URL` pattern above.
 */
const DEFAULT_GITHUB_BASE_URL = "https://github.com";

export function githubBaseUrl(): string {
  return process.env.MAW_GITHUB_BASE_URL || DEFAULT_GITHUB_BASE_URL;
}

function archiveTagUrl(owner: string, repo: string, ref: string): string {
  return `${githubBaseUrl()}/${owner}/${repo}/archive/refs/tags/${ref}.tar.gz`;
}

function archiveBranchUrl(owner: string, repo: string, ref: string): string {
  return `${githubBaseUrl()}/${owner}/${repo}/archive/refs/heads/${ref}.tar.gz`;
}

/**
 * Resolve the latest release tag for `<owner>/<repo>` via `gh api`. Returns
 * null if `gh` is unavailable, the call fails, or the repo has no releases —
 * the caller falls back to the default branch tarball.
 *
 * Why `gh` and not raw fetch: `gh` already carries the operator's auth (so
 * private repos and elevated rate limits work) and is the only network tool
 * in the codebase that's already audited for that purpose.
 */
function fetchLatestReleaseTag(owner: string, repo: string): string | null {
  const r = spawnSync("gh", ["api", `repos/${owner}/${repo}/releases/latest`, "--jq", ".tag_name"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const tag = (r.stdout ?? "").trim();
  if (!tag) return null;
  return tag;
}

/**
 * Install a plugin from a Vercel-style GitHub source: `owner/repo[/sub][@ref]`
 * (#939). Resolves a GitHub archive URL, downloads, then hands off to
 * `installFromTarball` so the existing sdk/sha/lock gates apply uniformly.
 *
 * Ref resolution:
 *   • explicit `ref` set → try `refs/tags/<ref>.tar.gz`, fall back to
 *     `refs/heads/<ref>.tar.gz` on 404. Order matters: most operators write
 *     `@v1.2.3` meaning a tag; the heads fallback covers `@main` / `@dev`.
 *   • no ref → `gh api releases/latest` for the tag; then archive that.
 *     Fall back to `archive/HEAD.tar.gz` (default branch) if no releases.
 *
 * Subpath handling:
 *   • passed through to `installFromTarball.subpath` which uses
 *     `findMonorepoPluginRoot`. The single-segment `plugins/` auto-prefix
 *     is applied here so `owner/repo/foo` resolves to `plugins/foo` if
 *     that's where the plugin actually lives.
 */
export async function installFromGithub(
  ref: GithubRef,
  opts: { force?: boolean; weight?: number; pin?: boolean } = {},
): Promise<void> {
  const { owner, repo, subpath, ref: refName } = ref;

  // Provenance string — also used to render the source label in plugins.lock
  // and the install-success line. Mirrors how monorepo: is rendered.
  const provenance =
    `github:${owner}/${repo}` +
    (subpath ? `/${subpath}` : "") +
    (refName ? `@${refName}` : "");

  // Resolve a tarball URL. We download to a temp file (downloadTarball) and
  // try the next URL on failure rather than peeking via HEAD — github redirects
  // /archive/refs/* to a CDN, and a HEAD against the unsigned redirect URL
  // doesn't reflect tag-vs-branch existence reliably.
  const candidates: string[] = [];
  if (refName) {
    candidates.push(archiveTagUrl(owner, repo, refName));
    candidates.push(archiveBranchUrl(owner, repo, refName));
  } else {
    const latest = fetchLatestReleaseTag(owner, repo);
    if (latest) {
      candidates.push(archiveTagUrl(owner, repo, latest));
    }
    // Default-branch fallback. `archive/HEAD.tar.gz` resolves to the repo's
    // default branch on github.com without us having to query for its name.
    candidates.push(`${githubBaseUrl()}/${owner}/${repo}/archive/HEAD.tar.gz`);
  }

  let dlPath: string | null = null;
  let lastError = "no archive URLs were attempted";
  for (const url of candidates) {
    const dl = await downloadTarball(url);
    if (dl.ok) {
      dlPath = dl.path;
      break;
    }
    lastError = dl.error;
  }
  if (!dlPath) {
    throw new Error(
      `failed to fetch github archive for ${provenance}:\n  ${lastError}\n  tried: ${candidates.join(", ")}`,
    );
  }

  // Resolve the subpath inside the extracted repo. `installFromTarball.subpath`
  // is passed straight to `findMonorepoPluginRoot` which handles the
  // `<repo>-<ref>/<subpath>/` walk for github-archive wrappers.
  //
  // Auto-prefix convenience: when subpath is a single segment (no `/`) and
  // doesn't already start with `plugins/`, we tell `installFromTarball` to
  // try `plugins/<seg>` first. If that doesn't pan out the user can pass an
  // explicit `plugins/<seg>` themselves. The actual prefer-plugins/-then-
  // literal probing happens in the resolver below by trying both subpath
  // shapes against `findMonorepoPluginRoot` — but `installFromTarball`
  // takes a single subpath, so we resolve it here BEFORE the call by peeking
  // into the staging dir. To keep this simple and avoid changing
  // installFromTarball's contract, we do that auto-prefix probe inline:
  let effectiveSubpath = subpath;
  if (subpath && !subpath.includes("/")) {
    // Single segment — prefer `plugins/<seg>` if we can detect it. We don't
    // have the staging dir yet (installFromTarball owns extraction), so the
    // probe is a best-effort: try `plugins/<seg>` first and fall back. If
    // both fail, installFromTarball surfaces the clearer error.
    try {
      await installFromTarball(dlPath, {
        source: provenance,
        force: opts.force,
        weight: opts.weight,
        pin: opts.pin,
        subpath: `plugins/${subpath}`,
      });
      effectiveSubpath = `plugins/${subpath}`;
      // Success on the prefixed path — clean up and return.
      try { rmSync(join(dlPath, ".."), { recursive: true, force: true }); } catch { /* non-fatal */ }
      return;
    } catch (e: any) {
      // Only fall through on the "no plugin.json at subpath" sentinel —
      // any other error (sdk gate, sha mismatch) is real and must surface.
      const msg = String(e?.message ?? e);
      if (!/no plugin.json at subpath/.test(msg)) throw e;
      effectiveSubpath = subpath;
      // Re-download isn't needed: extraction was rolled back already inside
      // installFromTarball on the staging-cleanup branch. But the temp
      // tarball is still on disk — fall through to the literal-subpath try.
    }
  }

  try {
    await installFromTarball(dlPath, {
      source: provenance,
      force: opts.force,
      weight: opts.weight,
      pin: opts.pin,
      ...(effectiveSubpath ? { subpath: effectiveSubpath } : {}),
    });
  } finally {
    try {
      rmSync(join(dlPath, ".."), { recursive: true, force: true });
    } catch {
      // Non-fatal — temp dir cleanup.
    }
  }
}

export async function installFromMonorepo(
  subpath: string,
  tag: string,
  opts: { force?: boolean; weight?: number; pin?: boolean } = {},
): Promise<void> {
  const url = monorepoTarballUrl(tag);
  const dl = await downloadTarball(url);
  if (!dl.ok) {
    throw new Error(dl.error);
  }
  try {
    await installFromTarball(dl.path, {
      source: `monorepo:${subpath}@${tag}`,
      force: opts.force,
      weight: opts.weight,
      pin: opts.pin,
      subpath,
    });
  } finally {
    try {
      rmSync(join(dl.path, ".."), { recursive: true, force: true });
    } catch {
      // Non-fatal.
    }
  }
}
