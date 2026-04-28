/**
 * install-impl seam: tarball extraction, URL download, artifact hash verify.
 */

import type { PluginManifest } from "../../../plugin/types";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { hashFile } from "../../../plugin/registry";

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Run `tar -xzf <tarball> -C <destDir>` synchronously. Returns true on success.
 * We shell out to GNU tar rather than adding a `tar` npm dep — Bun ships without
 * streaming tar, and adding a dep for a single call is not worth it.
 */
export function extractTarball(tarballPath: string, destDir: string): { ok: true } | { ok: false; error: string } {
  // Path-traversal guard: list entries first, reject any that escape the staging dir.
  // GNU tar does not strip "../" by default; -C alone does not prevent traversal.
  const list = spawnSync("tar", ["-tzf", tarballPath], { encoding: "utf8" });
  if (list.status !== 0) {
    return { ok: false, error: `tar list failed: ${list.stderr || list.stdout || `exit ${list.status}`}` };
  }
  for (const entry of list.stdout.split("\n").filter(Boolean)) {
    if (entry.startsWith("/") || entry.split("/").includes("..")) {
      return { ok: false, error: `tarball rejected: path traversal in entry "${entry}"` };
    }
  }

  const r = spawnSync("tar", ["-xzf", tarballPath, "-C", destDir], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    return { ok: false, error: `tar extract failed: ${r.stderr || r.stdout || `exit ${r.status}`}` };
  }
  return { ok: true };
}

/**
 * Download a URL to a temp file. Verifies the content type looks like gzip/tar
 * before writing (per brief: "verify content-type is gzip/tar").
 */
export async function downloadTarball(url: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  // Scheme gate — defense in depth; detectMode already filters callers from cmdPluginInstall
  // but direct callers of this function would bypass that upstream check.
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: `download refused: only http/https URLs are allowed (got ${JSON.stringify(url.slice(0, 32))})` };
  }

  let res: Response;
  try {
    res = await fetch(url);
  } catch (e: any) {
    return { ok: false, error: `download failed: ${e.message}` };
  }
  if (!res.ok) {
    return { ok: false, error: `download failed: HTTP ${res.status} ${res.statusText}` };
  }

  // Size cap: reject before buffering if Content-Length already exceeds limit.
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) {
    return { ok: false, error: `download refused: Content-Length ${declared} exceeds ${MAX_DOWNLOAD_BYTES} byte limit` };
  }

  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  const ctOk =
    ct.includes("gzip") ||
    ct.includes("x-gzip") ||
    ct.includes("x-tar") ||
    ct.includes("tar+gzip") ||
    ct.includes("octet-stream"); // many CDNs return generic binary
  if (!ctOk) {
    return { ok: false, error: `unexpected content-type ${JSON.stringify(ct)} — expected gzip/tar` };
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  // Cap actual bytes too — Content-Length can be absent or spoofed.
  if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
    return { ok: false, error: `download refused: response body (${buf.byteLength} bytes) exceeds ${MAX_DOWNLOAD_BYTES} byte limit` };
  }

  const tmp = mkdtempSync(join(tmpdir(), "maw-dl-"));
  const filename = basename(new URL(url).pathname) || "plugin.tgz";
  const outPath = join(tmp, filename);
  writeFileSync(outPath, buf);
  return { ok: true, path: outPath };
}

/**
 * Source-plugin detector (#874 path A.3, hardened in #896).
 *
 * A "source plugin" is one that ships executable source rather than a
 * pre-built bundle — typical of community repos with `src/index.ts` +
 * `plugin.json` and no `dist/`. Bun runs `.ts`/`.js` source transparently,
 * so the install path can accept them without an ahead-of-time build. We
 * still hash the entry file's bytes for plugins.lock parity so
 * `recordInstall` / `--pin` / hash-mismatch all work uniformly.
 *
 * #896 — hardened to accept EITHER of:
 *   • no `artifact` + has `entry`         (canonical source shape, #874 A.3)
 *   • has `artifact.sha256 === null` + has `entry`  (half-built — entry is
 *     authoritative because the artifact has no committed bytes to verify)
 *
 * The second branch matters because parseManifest accepts `artifact.sha256
 * = null` as valid (a manifest mid-build). Pre-#896 those tarballs hit the
 * `manifest.artifact` truthy branch, fell through `verifyArtifactHash`'s
 * sha256-null fencepost, and never tried the perfectly valid `entry`. The
 * symptom looked like a stale-binary regression (#896): the user filed
 * `tarball manifest has no 'artifact' field` even on tarballs whose
 * plugin.json clearly had `entry: "./src/index.ts"` — the artifact branch
 * was rejecting them before the entry branch could rescue.
 */
export function isSourcePluginManifest(manifest: PluginManifest): boolean {
  const hasEntry = typeof manifest.entry === "string" && manifest.entry.length > 0;
  if (!hasEntry) return false;
  // Canonical source shape: no artifact at all.
  if (!manifest.artifact) return true;
  // Half-built: artifact declared but sha256 not yet computed. Entry is the
  // authoritative byte source.
  if (manifest.artifact.sha256 === null) return true;
  return false;
}

/**
 * Verify sha256 of `manifest.artifact.path` (relative to `dir`) matches
 * `expected`. If `expected` is null/undefined, the manifest's embedded hash is
 * used as the expected value — this is the legacy (circular) check kept as a
 * defense-in-depth fencepost for transport corruption. See #487 / plugins.lock
 * for the real adversarial check (registry-pinned hashes).
 *
 * #874 path A.3 — for source plugins (no `artifact`, has `entry`), the entry
 * file's bytes ARE the artifact. Hash that instead.
 *
 * #896 — when `manifest.artifact.path` doesn't exist on disk but the
 * manifest also declares `entry`, fall back to entry. Defensive against
 * tarballs whose artifact path got out of sync with their actual contents
 * (e.g. registry source republished with a stale dist reference).
 */
export function verifyArtifactHashAgainst(
  dir: string,
  manifest: PluginManifest,
  expected: string,
): { ok: true } | { ok: false; error: string } {
  let relPath: string;
  // #896: entry-first when source-shaped — covers no-artifact AND
  // half-built (sha256:null) shapes uniformly.
  if (isSourcePluginManifest(manifest)) {
    relPath = manifest.entry!;
  } else if (manifest.artifact) {
    relPath = manifest.artifact.path;
    // #896: artifact declared but missing on disk — try entry rescue.
    if (!existsSync(join(dir, relPath)) && typeof manifest.entry === "string" && manifest.entry.length > 0) {
      relPath = manifest.entry;
    }
  } else {
    return { ok: false, error: "tarball manifest has no 'artifact' or 'entry' field — rebuild with `maw plugin build` or declare an entry path" };
  }
  const artifactPath = join(dir, relPath);
  if (!existsSync(artifactPath)) {
    return { ok: false, error: `artifact missing at ${relPath}` };
  }
  const observed = hashFile(artifactPath);
  if (observed !== expected) {
    return {
      ok: false,
      error:
        `artifact hash mismatch — refusing to install.\n` +
        `  expected: ${expected}\n` +
        `  actual:   ${observed}`,
    };
  }
  return { ok: true };
}

/**
 * Legacy manifest-only hash check. Kept as defense-in-depth fencepost per
 * #487 §8 Phase 1.
 *
 * #874 path A.3 — source plugins (no `artifact`, has `entry`) skip this
 * fencepost: there is no embedded hash to check against, so the registry-
 * pinned hash in plugins.lock is the only authoritative source. Tampering
 * is still detected at the pinned-hash check in `installFromTarball`.
 *
 * #896 — `isSourcePluginManifest` now accepts both no-artifact and
 * half-built (artifact.sha256===null) shapes when entry is present. Both
 * fall through to entry-only existence verification.
 */
export function verifyArtifactHash(dir: string, manifest: PluginManifest): { ok: true } | { ok: false; error: string } {
  if (isSourcePluginManifest(manifest)) {
    // Source plugins have no embedded sha256 to fencepost against. Verify the
    // entry file at least exists; the real adversarial check is plugins.lock.
    const entryPath = join(dir, manifest.entry!);
    if (!existsSync(entryPath)) {
      return { ok: false, error: `source entry missing at ${manifest.entry}` };
    }
    return { ok: true };
  }
  if (!manifest.artifact) {
    return { ok: false, error: "tarball manifest has no 'artifact' or 'entry' field — rebuild with `maw plugin build` or declare an entry path" };
  }
  if (manifest.artifact.sha256 === null) {
    // Should be unreachable thanks to #896 isSourcePluginManifest covering
    // half-built + entry. Kept as a fencepost for the no-entry case.
    return { ok: false, error: "tarball manifest has artifact.sha256=null (unbuilt) and no entry fallback — rebuild with `maw plugin build`" };
  }
  return verifyArtifactHashAgainst(dir, manifest, manifest.artifact.sha256);
}
