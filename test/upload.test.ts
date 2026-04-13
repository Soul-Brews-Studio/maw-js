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
});

// --- POST /upload ---

describe("POST /upload", () => {
  test("valid file → 200 + {ok, path, name, size}", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File(["hello upload content"], "hello.txt", { type: "text/plain" }),
    );
    const res = await app.handle(
      new Request("http://localhost/upload", { method: "POST", body: form }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.name).toBe("hello.txt");
    expect(body.path).toInclude(INBOX);
    expect(body.size).toBeDefined();
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
