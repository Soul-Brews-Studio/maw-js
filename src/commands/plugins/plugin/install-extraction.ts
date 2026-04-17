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

/** Verify sha256 of `artifactPath` (relative to dir) matches `expected`. */
export function verifyArtifactHash(dir: string, manifest: PluginManifest): { ok: true } | { ok: false; error: string } {
  if (!manifest.artifact) {
    return { ok: false, error: "tarball manifest has no 'artifact' field — rebuild with `maw plugin build`" };
  }
  if (manifest.artifact.sha256 === null) {
    return { ok: false, error: "tarball manifest has artifact.sha256=null (unbuilt) — rebuild with `maw plugin build`" };
  }
  const artifactPath = join(dir, manifest.artifact.path);
  if (!existsSync(artifactPath)) {
    return { ok: false, error: `artifact missing at ${manifest.artifact.path}` };
  }
  const observed = hashFile(artifactPath);
  if (observed !== manifest.artifact.sha256) {
    return {
      ok: false,
      error:
        `artifact hash mismatch — refusing to install.\n` +
        `  expected: ${manifest.artifact.sha256}\n` +
        `  actual:   ${observed}`,
    };
  }
  return { ok: true };
}
