/**
 * Tests for src/api/threads.ts — GET/POST /api/threads, GET/POST /api/thread.
 *
 * Uses Elysia's .handle() for in-process dispatch (no port binding).
 * Each test gets a fresh sqlite file via MAW_THREADS_DB.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { threadsApi } from "../../src/api/threads";

const tmpRoot = mkdtempSync(join(tmpdir(), "maw-threads-test-"));
afterAll(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

let counter = 0;
function freshApp() {
  counter += 1;
  // The threads module reopens its DB handle when MAW_THREADS_DB changes,
  // so each test gets isolated storage without re-importing.
  process.env.MAW_THREADS_DB = join(tmpRoot, `t${counter}.db`);
  return new Elysia({ prefix: "/api" }).use(threadsApi);
}

type App = ReturnType<typeof freshApp>;

async function jsonGet(app: App, path: string): Promise<{ status: number; body: any }> {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json() };
}

async function jsonPost(app: App, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

describe("GET /api/threads", () => {
  test("returns empty list when no threads exist", async () => {
    const app = freshApp();
    const { status, body } = await jsonGet(app, "/api/threads");
    expect(status).toBe(200);
    expect(body).toEqual({ threads: [] });
  });

  test("filters by status", async () => {
    const app = freshApp();
    await jsonPost(app, "/api/thread", { message: "hi", title: "channel:a" });
    await jsonPost(app, "/api/thread", { message: "hi", title: "channel:b" });
    const { body: open } = await jsonGet(app, "/api/threads?status=open");
    expect(open.threads.length).toBe(2);
    const { body: closed } = await jsonGet(app, "/api/threads?status=closed");
    expect(closed.threads).toEqual([]);
  });

  test("respects limit", async () => {
    const app = freshApp();
    for (let i = 0; i < 3; i++) {
      await jsonPost(app, "/api/thread", { message: `m${i}`, title: `channel:t${i}` });
    }
    const { body } = await jsonGet(app, "/api/threads?limit=2");
    expect(body.threads.length).toBe(2);
  });
});

describe("POST /api/thread (create)", () => {
  test("creating with title returns thread_id, message_id, status:ok, oracle_response:null", async () => {
    const app = freshApp();
    const { status, body } = await jsonPost(app, "/api/thread", {
      message: "hello",
      role: "claude",
      title: "channel:test",
    });
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.oracle_response).toBeNull();
    expect(typeof body.thread_id).toBe("number");
    expect(typeof body.message_id).toBe("number");
  });

  test("creating without thread_id or title returns 400", async () => {
    const app = freshApp();
    const { status, body } = await jsonPost(app, "/api/thread", { message: "lonely" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/thread_id or title required/);
  });

  test("supplying BOTH thread_id and title returns 400", async () => {
    const app = freshApp();
    const first = await jsonPost(app, "/api/thread", { message: "anchor", title: "channel:both" });
    const { status, body } = await jsonPost(app, "/api/thread", {
      message: "ambiguous",
      thread_id: first.body.thread_id,
      title: "channel:other",
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/thread_id OR title/);
  });

  test("empty message rejected by schema (422)", async () => {
    const app = freshApp();
    const { status } = await jsonPost(app, "/api/thread", { message: "", title: "channel:e" });
    // Elysia returns 422 for typebox validation failures
    expect([400, 422]).toContain(status);
  });
});

describe("POST /api/thread (append)", () => {
  test("appending to existing thread returns higher message_id", async () => {
    const app = freshApp();
    const first = await jsonPost(app, "/api/thread", { message: "one", title: "channel:x" });
    const second = await jsonPost(app, "/api/thread", { message: "two", thread_id: first.body.thread_id });
    expect(second.status).toBe(200);
    expect(second.body.thread_id).toBe(first.body.thread_id);
    expect(second.body.message_id).toBeGreaterThan(first.body.message_id);
  });

  test("appending to non-existent thread returns 409", async () => {
    const app = freshApp();
    const { status, body } = await jsonPost(app, "/api/thread", {
      message: "ghost",
      thread_id: 9999,
    });
    expect(status).toBe(409);
    expect(body.error).toMatch(/thread not found or closed/);
  });
});

describe("GET /api/thread/:id", () => {
  test("returns thread + ordered messages", async () => {
    const app = freshApp();
    const created = await jsonPost(app, "/api/thread", { message: "first", title: "channel:y" });
    await jsonPost(app, "/api/thread", { message: "second", thread_id: created.body.thread_id });
    await jsonPost(app, "/api/thread", { message: "third", thread_id: created.body.thread_id });

    const { status, body } = await jsonGet(app, `/api/thread/${created.body.thread_id}`);
    expect(status).toBe(200);
    expect(body.thread.title).toBe("channel:y");
    expect(body.thread.status).toBe("open");
    expect(body.messages.map((m: any) => m.content)).toEqual(["first", "second", "third"]);
    // ISO-8601 with Z
    expect(body.thread.created_at).toMatch(/T.*Z$/);
    expect(body.messages[0].created_at).toMatch(/T.*Z$/);
  });

  test("returns 404 for missing thread", async () => {
    const app = freshApp();
    const { status, body } = await jsonGet(app, "/api/thread/9999");
    expect(status).toBe(404);
    expect(body.error).toMatch(/thread not found/);
  });
});

describe("end-to-end channel:<target> flow", () => {
  test("find-or-create pattern used by talk-to plugin", async () => {
    const app = freshApp();
    // 1. List — empty
    const empty = await jsonGet(app, "/api/threads?limit=50");
    expect(empty.body.threads).toEqual([]);

    // 2. First message → creates thread
    const first = await jsonPost(app, "/api/thread", {
      message: "ping",
      role: "claude",
      title: "channel:pimquin",
    });
    expect(first.body.status).toBe("ok");
    const tid = first.body.thread_id;

    // 3. Plugin's find-or-create lookup
    const found = await jsonGet(app, "/api/threads?limit=50");
    const channel = found.body.threads.find((t: any) =>
      t.title === "channel:pimquin" && t.status !== "closed"
    );
    expect(channel?.id).toBe(tid);

    // 4. Second message → appends
    const second = await jsonPost(app, "/api/thread", {
      message: "pong",
      role: "claude",
      thread_id: tid,
    });
    expect(second.body.thread_id).toBe(tid);
    expect(second.body.message_id).toBeGreaterThan(first.body.message_id);

    // 5. Read full thread
    const full = await jsonGet(app, `/api/thread/${tid}`);
    expect(full.body.messages.length).toBe(2);
  });
});
