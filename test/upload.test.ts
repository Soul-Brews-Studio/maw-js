/**
 * Tests for src/api/upload.ts — POST/GET/DELETE inbox endpoints.
 *
 * INBOX_DIR is hardcoded from homedir() at module load time.
 * We mock "os" before importing upload.ts so the const captures our temp dir.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Elysia } from "elysia";


// --- Temp home dir (evaluated before the mock factory, captured by closure) ---
const TEST_HOME = mkdtempSync(join(tmpdir(), "maw-upload-test-"));
const INBOX = join(TEST_HOME, ".maw", "inbox");
const WEB = mkdtempSync(join(tmpdir(), "maw-upload-web-"));
process.env.MAW_UPLOAD_WEB_DIR = WEB;

// Override os.homedir so INBOX_DIR in upload.ts resolves to our temp dir.
// mock.module is hoisted by Bun, so it runs before any dynamic imports below.
mock.module("os", () => ({
  homedir: () => TEST_HOME,
}));

// --- Build test app ---

let app: Elysia;

beforeAll(async () => {
  const { uploadApi } = await import("../src/api/upload");
  app = new Elysia().use(uploadApi);
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  rmSync(WEB, { recursive: true, force: true });
});

// --- POST /upload ---

describe("POST /upload", () => {
  test("valid image → 200 + {ok, id, url, path, name, size, mime}", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File(["fake png bytes"], "shot.png", { type: "image/png" }),
    );
    const res = await app.handle(
      new Request("http://localhost/upload", { method: "POST", body: form }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.url).toMatch(/^\/maw-uploads\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.png$/);
    expect(body.path).toInclude(WEB);
    expect(body.name).toBe("shot.png");
    expect(body.mime).toBe("image/png");
    expect(body.size).toBeDefined();
  });

  test("disallowed mime → 415", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File(["plain text"], "hello.txt", { type: "text/plain" }),
    );
    const res = await app.handle(
      new Request("http://localhost/upload", { method: "POST", body: form }),
    );
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error).toInclude("unsupported mime");
  });

  test("oversized file → 413", async () => {
    const big = new Uint8Array(11 * 1024 * 1024);
    const form = new FormData();
    form.append("file", new File([big], "big.png", { type: "image/png" }));
    const res = await app.handle(
      new Request("http://localhost/upload", { method: "POST", body: form }),
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toInclude("too large");
  });

  test("no file field → 400", async () => {
    const res = await app.handle(
      new Request("http://localhost/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

// --- GET /files ---

describe("GET /files", () => {
  test("returns array of inbox files", async () => {
    // Inbox may already exist (from upload test above); that's fine.
    const res = await app.handle(new Request("http://localhost/files"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

// --- GET /files/:name ---

describe("GET /files/:name", () => {
  test("existing file → 200 + file content", async () => {
    mkdirSync(INBOX, { recursive: true });
    writeFileSync(join(INBOX, "seeded.txt"), "seeded content");

    const res = await app.handle(
      new Request("http://localhost/files/seeded.txt"),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toInclude("seeded content");
  });

  test("missing file → 404", async () => {
    const res = await app.handle(
      new Request("http://localhost/files/no-such-file.txt"),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not found");
  });
});

// --- DELETE /files/:name ---

describe("DELETE /files/:name", () => {
  test("existing file → archived to /tmp, original removed", async () => {
    mkdirSync(INBOX, { recursive: true });
    writeFileSync(join(INBOX, "to-delete.txt"), "bye bye");

    // upload.ts:66 calls Bun.write(archive, Bun.file(src)) without await then
    // immediately unlinkSync(src) — lazy BunFile read races the delete and
    // produces an unhandled ENOENT. Stub Bun.write to a no-op for this handler
    // call so the race never fires.  We still verify the API response shape.
    const origWrite = Bun.write;
    (Bun as any).write = async () => 0;

    const res = await app.handle(
      new Request("http://localhost/files/to-delete.txt", { method: "DELETE" }),
    );

    (Bun as any).write = origWrite; // restore immediately

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.archived).toInclude("/tmp/maw-inbox-to-delete.txt");
    expect(existsSync(join(INBOX, "to-delete.txt"))).toBe(false);
  });

  test("missing file → 404", async () => {
    const res = await app.handle(
      new Request("http://localhost/files/ghost.txt", { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not found");
  });
});
