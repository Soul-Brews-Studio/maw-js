import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const {
  downloadTarball,
  extractTarball,
  isSourcePluginManifest,
  verifyArtifactHash,
  verifyArtifactHashAgainst,
} = await import("../../src/vendor/mpr-plugins/init/internal/install-extraction.ts?init-install-extraction-coverage");

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

describe("vendor init install-extraction coverage", () => {
  const originalFetch = globalThis.fetch;
  const created: string[] = [];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix = "maw-init-install-extraction-") {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    created.push(dir);
    return dir;
  }

  function sha256(body: string) {
    return "sha256:" + createHash("sha256").update(body).digest("hex");
  }

  test("extractTarball rejects invalid archives and traversal before successful extraction", () => {
    const invalid = join(tempDir(), "not-a-tar.tgz");
    writeFileSync(invalid, "not gzip");
    const listFail = extractTarball(invalid, tempDir());
    expect(listFail.ok).toBe(false);
    if (!listFail.ok) expect(listFail.error).toContain("tar list failed:");

    const fixture = tempDir();
    writeFileSync(join(fixture, "safe.txt"), "safe\n");
    const safeTar = join(fixture, "safe.tgz");
    const tar = spawnSync("tar", ["-czf", safeTar, "-C", fixture, "safe.txt"]);
    expect(tar.status).toBe(0);

    const missingDest = extractTarball(safeTar, join(fixture, "missing-dest"));
    expect(missingDest.ok).toBe(false);
    if (!missingDest.ok) expect(missingDest.error).toContain("tar extract failed:");

    const dest = tempDir();
    expect(extractTarball(safeTar, dest)).toEqual({ ok: true });
    expect(readFileSync(join(dest, "safe.txt"), "utf8")).toBe("safe\n");
  });

  test("downloadTarball covers scheme, network, HTTP, declared/actual size, content-type, filename fallback, and success", async () => {
    expect(await downloadTarball("file:///tmp/plugin.tgz")).toEqual({
      ok: false,
      error: 'download refused: only http/https URLs are allowed (got "file:///tmp/plugin.tgz")',
    });

    globalThis.fetch = mock(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await downloadTarball("https://example.test/plugin.tgz")).toEqual({ ok: false, error: "download failed: offline" });

    globalThis.fetch = mock(async () => new Response("missing", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
    expect(await downloadTarball("https://example.test/plugin.tgz")).toEqual({ ok: false, error: "download failed: HTTP 404 Not Found" });

    globalThis.fetch = mock(async () => new Response("too big", {
      headers: { "content-length": String(MAX_DOWNLOAD_BYTES + 1), "content-type": "application/gzip" },
    })) as unknown as typeof fetch;
    expect(await downloadTarball("https://example.test/plugin.tgz")).toEqual({
      ok: false,
      error: "download refused: Content-Length 52428801 exceeds 52428800 byte limit",
    });

    globalThis.fetch = mock(async () => new Response("html", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    expect(await downloadTarball("https://example.test/plugin.tgz")).toEqual({
      ok: false,
      error: 'unexpected content-type "text/html" — expected gzip/tar',
    });

    globalThis.fetch = mock(async () => new Response(new Uint8Array(MAX_DOWNLOAD_BYTES + 1), {
      headers: { "content-type": "application/gzip" },
    })) as unknown as typeof fetch;
    expect(await downloadTarball("https://example.test/plugin.tgz")).toEqual({
      ok: false,
      error: "download refused: response body (52428801 bytes) exceeds 52428800 byte limit",
    });

    const body = new Uint8Array([1, 2, 3, 4]);
    globalThis.fetch = mock(async () => new Response(body, {
      headers: { "content-type": "application/octet-stream" },
    })) as unknown as typeof fetch;
    const ok = await downloadTarball("https://example.test/");
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.path.endsWith("/plugin.tgz")).toBe(true);
      expect(Array.from(readFileSync(ok.path))).toEqual([1, 2, 3, 4]);
      created.push(join(ok.path, ".."));
    }
  });

  test("artifact hash verification covers source-shaped manifests, fallbacks, missing data, mismatches, and success", () => {
    const dir = tempDir();
    expect(isSourcePluginManifest({ name: "no-entry", version: "1.0.0", sdk: "*" } as any)).toBe(false);
    expect(isSourcePluginManifest({ name: "built", version: "1.0.0", sdk: "*", entry: "src.ts", artifact: { path: "dist.js", sha256: sha256("dist") } } as any)).toBe(false);
    expect(isSourcePluginManifest({ name: "source", version: "1.0.0", sdk: "*", entry: "src.ts" } as any)).toBe(true);
    expect(isSourcePluginManifest({ name: "half", version: "1.0.0", sdk: "*", entry: "src.ts", artifact: { path: "dist.js", sha256: null } } as any)).toBe(true);

    expect(verifyArtifactHash(dir, { name: "naked", version: "1.0.0", sdk: "*" } as any)).toEqual({
      ok: false,
      error: "tarball manifest has no 'artifact' or 'entry' field — rebuild with `maw plugin build` or declare an entry path",
    });
    expect(verifyArtifactHash(dir, { name: "null-no-entry", version: "1.0.0", sdk: "*", artifact: { path: "dist.js", sha256: null } } as any)).toEqual({
      ok: false,
      error: "tarball manifest has artifact.sha256=null (unbuilt) and no entry fallback — rebuild with `maw plugin build`",
    });
    expect(verifyArtifactHash(dir, { name: "source-missing", version: "1.0.0", sdk: "*", entry: "src.ts" } as any)).toEqual({
      ok: false,
      error: "source entry missing at src.ts",
    });

    writeFileSync(join(dir, "src.ts"), "entry bytes\n");
    expect(verifyArtifactHash(dir, { name: "source-ok", version: "1.0.0", sdk: "*", entry: "src.ts" } as any)).toEqual({ ok: true });
    expect(verifyArtifactHashAgainst(dir, { name: "source-against", version: "1.0.0", sdk: "*", entry: "src.ts" } as any, sha256("entry bytes\n"))).toEqual({ ok: true });

    expect(verifyArtifactHashAgainst(dir, { name: "empty", version: "1.0.0", sdk: "*" } as any, "sha256:expected")).toEqual({
      ok: false,
      error: "tarball manifest has no 'artifact' or 'entry' field — rebuild with `maw plugin build` or declare an entry path",
    });
    expect(verifyArtifactHashAgainst(dir, { name: "missing-artifact", version: "1.0.0", sdk: "*", artifact: { path: "missing.js", sha256: "sha256:missing" } } as any, "sha256:missing")).toEqual({
      ok: false,
      error: "artifact missing at missing.js",
    });

    writeFileSync(join(dir, "dist.js"), "dist bytes\n");
    const mismatch = verifyArtifactHashAgainst(dir, { name: "mismatch", version: "1.0.0", sdk: "*", artifact: { path: "dist.js", sha256: sha256("dist bytes\n") } } as any, "sha256:expected");
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.error).toContain("artifact hash mismatch");
      expect(mismatch.error).toContain("expected: sha256:expected");
      expect(mismatch.error).toContain("actual:");
    }

    expect(verifyArtifactHashAgainst(dir, { name: "fallback", version: "1.0.0", sdk: "*", entry: "src.ts", artifact: { path: "missing-dist.js", sha256: "sha256:not-used" } } as any, sha256("entry bytes\n"))).toEqual({ ok: true });
    expect(verifyArtifactHash(dir, { name: "built", version: "1.0.0", sdk: "*", artifact: { path: "dist.js", sha256: sha256("dist bytes\n") } } as any)).toEqual({ ok: true });
  });
});
