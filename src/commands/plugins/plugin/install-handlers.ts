/**
 * install-impl seam: per-source-type install handlers.
 * installFromDir / installFromTarball / installFromUrl
 */

import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { basename, join } from "path";
import { formatSdkMismatchError, runtimeSdkVersion, satisfies } from "../../../plugin/registry";
import { installRoot, removeExisting } from "./install-source-detect";
import { extractTarball, downloadTarball, verifyArtifactHash, verifyArtifactHashAgainst } from "./install-extraction";
import { readManifest, printInstallSuccess } from "./install-manifest-helpers";
import { readLock, pinPlugin } from "./lock";

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

  printInstallSuccess(manifest!, dest, "linked (dev)");
}

export async function installFromTarball(
  tarballPath: string,
  opts: { source: string; force?: boolean; weight?: number; pin?: boolean },
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

  const manifest = readManifest(staging);
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
  const selfHashResult = verifyArtifactHash(staging, manifest!);
  if (!selfHashResult.ok) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(selfHashResult.error);
  }

  // Registry-pinned verification (#487 Option A). The expected hash comes from
  // the operator-curated lockfile, not the tarball itself — this is what
  // closes the MITM / CDN-swap threat.
  let lock;
  try {
    lock = readLock();
  } catch (e: any) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  const pinned = lock.plugins[manifest!.name];
  if (!pinned) {
    if (!opts.pin) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error(
        `plugin '${manifest!.name}' not in plugins.lock — run: maw plugin pin ${manifest!.name} ${opts.source}\n` +
        `  (or re-run install with --pin to add it now)`,
      );
    }
    // --pin: accept this install AND stage the lock entry using the hash we
    // just verified via the manifest. Safe because we already asserted the
    // tarball is internally consistent; --pin is an explicit trust handshake.
  } else {
    if (pinned.version !== manifest!.version) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error(
        `plugin '${manifest!.name}' version mismatch: plugins.lock=${pinned.version} tarball=${manifest!.version}`,
      );
    }
    const pinnedResult = verifyArtifactHashAgainst(staging, manifest!, pinned.sha256);
    if (!pinnedResult.ok) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error(
        `plugin '${manifest!.name}' ${pinnedResult.error}\n` +
        `  lockfile hash did not match — this is the real adversarial check (#487).`,
      );
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
  try {
    const { renameSync } = require("fs");
    renameSync(staging, dest);
  } catch {
    // Cross-device fallback (rare). Fall back to cp -a then rm -rf.
    spawnSync("cp", ["-a", staging + "/.", dest], { encoding: "utf8" });
    rmSync(staging, { recursive: true, force: true });
  }

  // --pin: after a successful install, stage the lockfile entry. We pin using
  // the original tarball path so `maw plugin pin --verify` (future) can
  // re-hash from the same source.
  if (opts.pin && !lock.plugins[manifest!.name]) {
    pinPlugin(manifest!.name, tarballPath);
  }

  const sourceNote = opts.source.startsWith("http") ? `from ${opts.source}` : "";
  printInstallSuccess(
    manifest!,
    dest,
    { sha256: manifest!.artifact!.sha256! },
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
