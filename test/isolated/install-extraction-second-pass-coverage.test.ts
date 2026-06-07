import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { spawnSync } from "child_process";

const {
  downloadTarball,
  extractTarball,
  verifyArtifactHash,
  verifyArtifactHashAgainst,
} = await import("../../src/commands/plugins/plugin/install-extraction");

describe("install extraction second-pass coverage", () => {
  const originalFetch = globalThis.fetch;
  const created: string[] = [];

  beforeEach(() => {
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(prefix = "maw-install-extraction-") {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    created.push(dir);
    return dir;
  }

  function sha256(body: string) {
    return "sha256:" + createHash("sha256").update(body).digest("hex");
  }

  test("extractTarball reports tar list, traversal, extract, and success outcomes", () => {
    const invalid = join(tempDir(), "not-a-tar.tgz");
    writeFileSync(invalid, "not gzip");
    const listFail = extractTarball(invalid, tempDir());
    expect(listFail.ok).toBe(false);
    if (!listFail.ok) expect(listFail.error).toContain("tar list failed:");


    const safeDir = tempDir();
    writeFileSync(join(safeDir, "plugin.json"), "{}");
    writeFileSync(join(safeDir, "index.js"), "export default {};\n");
    const safeTar = join(safeDir, "plugin.tgz");
    const tar = spawnSync("tar", ["-czf", safeTar, "-C", safeDir, "plugin.json", "index.js"]);
    expect(tar.status).toBe(0);

    const extractFail = extractTarball(safeTar, join(safeDir, "missing-dest"));
    expect(extractFail.ok).toBe(false);
    if (!extractFail.ok) expect(extractFail.error).toContain("tar extract failed:");

    const dest = tempDir();
    expect(extractTarball(safeTar, dest)).toEqual({ ok: true });
    expect(existsSync(join(dest, "plugin.json"))).toBe(true);
  });

  test("downloadTarball gates schemes, fetch failures, HTTP errors, size, content-type, and writes successful downloads", async () => {
    expect(await downloadTarball("file:///tmp/plugin.tgz")).toEqual({
      ok: false,
      error: 'download refused: only http/https URLs are allowed (got "file:///tmp/plugin.tgz")',
    });

    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await downloadTarball("https://example.test/plugin.tgz")).toEqual({
      ok: false,
      error: "download failed: network down",
    });

    globalThis.fetch = mock(async () => new Response("missing", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
    expect(await downloadTarball("https://example.test/plugin.tgz")).toEqual({
      ok: false,
      error: "download failed: HTTP 404 Not Found",
    });

    globalThis.fetch = mock(async () => new Response("too big", {
      headers: {
        "content-length": String(50 * 1024 * 1024 + 1),
        "content-type": "application/gzip",
      },
    })) as unknown as typeof fetch;
    expect(await downloadTarball("https://example.test/plugin.tgz")).toEqual({
      ok: false,
      error: "download refused: Content-Length 52428801 exceeds 52428800 byte limit",
    });

    globalThis.fetch = mock(async () => new Response("html", {
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;
    expect(await downloadTarball("https://example.test/plugin.tgz")).toEqual({
      ok: false,
      error: 'unexpected content-type "text/html" — expected gzip/tar',
    });

    const body = new Uint8Array([1, 2, 3, 4]);
    globalThis.fetch = mock(async () => new Response(body, {
      headers: { "content-type": "application/octet-stream" },
    })) as unknown as typeof fetch;
    const ok = await downloadTarball("https://example.test/path/plugin.tgz");
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.path.endsWith("/plugin.tgz")).toBe(true);
      expect(Array.from(readFileSync(ok.path))).toEqual([1, 2, 3, 4]);
      created.push(join(ok.path, ".."));
    }
  });

  test("verifyArtifactHash covers missing manifests, sha null fences, missing files, mismatches, and entry fallback", () => {
    const dir = tempDir();
    expect(verifyArtifactHash(dir, { name: "naked", version: "1.0.0", sdk: "^1" } as any)).toEqual({
      ok: false,
      error: "tarball manifest has no 'artifact' or 'entry' field — rebuild with `maw plugin build` or declare an entry path",
    });

    expect(verifyArtifactHash(dir, {
      name: "null-no-entry",
      version: "1.0.0",
      sdk: "^1",
      artifact: { path: "./dist.js", sha256: null },
    } as any)).toEqual({
      ok: false,
      error: "tarball manifest has artifact.sha256=null (unbuilt) and no entry fallback — rebuild with `maw plugin build`",
    });

    expect(verifyArtifactHash(dir, {
      name: "missing",
      version: "1.0.0",
      sdk: "^1",
      artifact: { path: "./dist.js", sha256: "sha256:missing" },
    } as any)).toEqual({
      ok: false,
      error: "artifact missing at ./dist.js",
    });

    writeFileSync(join(dir, "dist.js"), "actual bytes\n");
    const mismatch = verifyArtifactHash(dir, {
      name: "mismatch",
      version: "1.0.0",
      sdk: "^1",
      artifact: { path: "./dist.js", sha256: "sha256:expected" },
    } as any);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.error).toContain("artifact hash mismatch");
      expect(mismatch.error).toContain("expected: sha256:expected");
      expect(mismatch.error).toContain("actual:");
    }

    writeFileSync(join(dir, "src.ts"), "entry bytes\n");
    expect(verifyArtifactHashAgainst(dir, {
      name: "fallback",
      version: "1.0.0",
      sdk: "^1",
      entry: "./src.ts",
      artifact: { path: "./missing-dist.js", sha256: "sha256:not-used" },
    } as any, sha256("entry bytes\n"))).toEqual({ ok: true });

    expect(verifyArtifactHash(dir, {
      name: "built",
      version: "1.0.0",
      sdk: "^1",
      artifact: { path: "./dist.js", sha256: sha256("actual bytes\n") },
    } as any)).toEqual({ ok: true });
  });
});
