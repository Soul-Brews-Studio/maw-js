/**
 * plugin-mcp-room-standalone.test.ts — boundary + behavior for the 5 room MCP tools.
 *
 * Boundary: room-client.ts must import only from maw-js/sdk (boundary #2113).
 * Behavior: each tool maps the correct HTTP method + path; non-200 → isError.
 * Injected deps — no live server, no network.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  roomRead,
  roomReply,
  roomMerge,
  roomClose,
  roomOpen,
  type RoomClientDeps,
  type RoomHttpResponse,
} from "../../src/vendor/mpr-plugins/mcp/room-client";

const root = join(import.meta.dir, "../..");
const MCP_DIR = "src/vendor/mpr-plugins/mcp";

// ── boundary ──────────────────────────────────────────────────────────────────

describe("room-client boundary (#2113)", () => {
  test("room-client.ts imports only from maw-js/sdk (not core/cli/config/lib)", () => {
    const source = readFileSync(join(root, MCP_DIR, "room-client.ts"), "utf8");
    expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib|plugin)(?:\/|")/);
    expect(source).toContain('from "maw-js/sdk"');
  });
  test("server.ts registers all 5 maw_room_* tools", () => {
    const server = readFileSync(join(root, MCP_DIR, "server.ts"), "utf8");
    for (const name of ["maw_room_read", "maw_room_reply", "maw_room_merge", "maw_room_close", "maw_room_open"]) {
      expect(server).toContain(`"${name}"`);
    }
    expect(server).toContain("roomRead");
    expect(server).toContain("roomReply");
    expect(server).toContain("roomMerge");
    expect(server).toContain("roomClose");
    expect(server).toContain("roomOpen");
  });
});

// ── test helpers ──────────────────────────────────────────────────────────────

interface Captured { url: string; init?: RequestInit }

function makeDeps(res: Partial<RoomHttpResponse> = {}): { deps: RoomClientDeps; calls: Captured[] } {
  const calls: Captured[] = [];
  const response: RoomHttpResponse = { ok: true, status: 200, body: { ok: true }, ...res };
  const deps: RoomClientDeps = {
    localBaseUrl: () => "http://127.0.0.1:9999",
    fetch: async (url, init) => { calls.push({ url, init }); return response; },
  };
  return { deps, calls };
}

// ── maw_room_read ─────────────────────────────────────────────────────────────

describe("roomRead", () => {
  test("GET /api/room/thread with correct query params", async () => {
    const { deps, calls } = makeDeps({ body: { ok: true, room: { messages: [] } } });
    const result = await roomRead({ company: "kobo", room: "bash-mcp" }, deps);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:9999/api/room/thread?company=kobo&room=bash-mcp");
    expect(calls[0].init).toBeUndefined(); // GET → no body
  });

  test("non-200 → ok=false, surfaces error in text", async () => {
    const { deps } = makeDeps({ ok: false, status: 404, body: { ok: false, error: "room not found: x" } });
    const result = await roomRead({ company: "kobo", room: "x" }, deps);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("room not found: x");
  });

  test("URL-encodes company and room", async () => {
    const { deps, calls } = makeDeps();
    await roomRead({ company: "my company", room: "a/b" }, deps);
    expect(calls[0].url).toContain("company=my%20company");
    expect(calls[0].url).toContain("room=a%2Fb");
  });
});

// ── maw_room_reply ────────────────────────────────────────────────────────────

describe("roomReply", () => {
  test("POST /api/room/reply with correct JSON body", async () => {
    const { deps, calls } = makeDeps({ body: { ok: true, room: {} } });
    const result = await roomReply({ company: "kobo", room: "bash-mcp", from: "eq3", text: "hello" }, deps);
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe("http://127.0.0.1:9999/api/room/reply");
    expect(calls[0].init?.method).toBe("POST");
    const sent = JSON.parse(calls[0].init?.body as string);
    expect(sent).toEqual({ company: "kobo", room: "bash-mcp", from: "eq3", text: "hello" });
  });

  test("non-200 → ok=false, error surfaced", async () => {
    const { deps } = makeDeps({ ok: false, status: 403, body: { ok: false, error: "may not reply here" } });
    const result = await roomReply({ company: "kobo", room: "bash-mcp", from: "web", text: "hi" }, deps);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("may not reply here");
  });
});

// ── maw_room_merge ────────────────────────────────────────────────────────────

describe("roomMerge", () => {
  test("POST /api/room/merge with confirm:true forwarded automatically", async () => {
    const { deps, calls } = makeDeps({ body: { ok: true, room: {} } });
    const result = await roomMerge({ company: "kobo", target: "main", sources: ["sub1", "sub2"] }, deps);
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe("http://127.0.0.1:9999/api/room/merge");
    const sent = JSON.parse(calls[0].init?.body as string);
    expect(sent.confirm).toBe(true);
    expect(sent.target).toBe("main");
    expect(sent.sources).toEqual(["sub1", "sub2"]);
  });

  test("non-200 → ok=false, error surfaced", async () => {
    const { deps } = makeDeps({ ok: false, status: 404, body: { ok: false, error: "target room not found: x" } });
    const result = await roomMerge({ company: "kobo", target: "x", sources: ["s"] }, deps);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("target room not found: x");
  });
});

// ── maw_room_close ────────────────────────────────────────────────────────────

describe("roomClose", () => {
  test("POST /api/room/close with correct body", async () => {
    const { deps, calls } = makeDeps({ body: { ok: true, room: {} } });
    const result = await roomClose({ company: "kobo", room: "bash-mcp" }, deps);
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe("http://127.0.0.1:9999/api/room/close");
    const sent = JSON.parse(calls[0].init?.body as string);
    expect(sent).toEqual({ company: "kobo", room: "bash-mcp" });
  });

  test("non-200 → ok=false, error surfaced", async () => {
    const { deps } = makeDeps({ ok: false, status: 404, body: { ok: false, error: "room not found: gone" } });
    const result = await roomClose({ company: "kobo", room: "gone" }, deps);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("room not found: gone");
  });
});

// ── maw_room_open ─────────────────────────────────────────────────────────────

describe("roomOpen", () => {
  test("POST /api/room/open with topic", async () => {
    const { deps, calls } = makeDeps({ body: { ok: true, room: {} } });
    const result = await roomOpen({ company: "kobo", room: "new-room", topic: "discuss scope" }, deps);
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe("http://127.0.0.1:9999/api/room/open");
    const sent = JSON.parse(calls[0].init?.body as string);
    expect(sent).toEqual({ company: "kobo", room: "new-room", topic: "discuss scope" });
  });

  test("POST /api/room/open without topic (optional)", async () => {
    const { deps, calls } = makeDeps({ body: { ok: true, room: {} } });
    await roomOpen({ company: "kobo", room: "new-room" }, deps);
    const sent = JSON.parse(calls[0].init?.body as string);
    expect(sent.topic).toBeUndefined();
  });

  test("non-200 → ok=false, error surfaced", async () => {
    const { deps } = makeDeps({ ok: false, status: 404, body: { ok: false, error: "unknown company: bad" } });
    const result = await roomOpen({ company: "bad", room: "r" }, deps);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("unknown company: bad");
  });
});
