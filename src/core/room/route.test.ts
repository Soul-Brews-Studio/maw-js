import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { roomTag, messageInRoom, roomSendArgs, handleRoomSendRequest, handleRoomOpenRequest, handleRoomCloseRequest, handleRoomReopenRequest, handleRoomThreadRequest } from "./route";
import { appendRoomMessage } from "./store";

const post = (body: unknown, spawn?: (a: string[]) => { exited: Promise<number> }) =>
  handleRoomSendRequest(
    new Request("http://x/api/room/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    spawn,
  );

describe("Brainstorm Room core wire (kobo-245)", () => {
  test("roomTag / messageInRoom scope a message to one room", () => {
    expect(roomTag("demo")).toBe("[room:demo]");
    expect(messageInRoom("[room:demo] hi", "demo")).toBe(true);
    expect(messageInRoom("[room:other] hi", "demo")).toBe(false);
    expect(messageInRoom(undefined, "demo")).toBe(false);
  });

  test("roomSendArgs reuses hey verbatim — argv = hey <lead> [room:<id>] <text>", () => {
    expect(roomSendArgs("demo", "eq3", "what next?")).toEqual(["hey", "eq3", "[room:demo] what next?"]);
  });

  test("POST /api/room/send delivers via the injected hey spawn (no real subprocess)", async () => {
    const calls: string[][] = [];
    const spawn = (argv: string[]) => { calls.push(argv); return { exited: Promise.resolve(0) }; };
    const res = await post({ room: "demo", to: "eq3", text: "hello lead" }, spawn);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(calls).toEqual([["hey", "eq3", "[room:demo] hello lead"]]); // exactly one hey, room-tagged
  });

  test("missing room/to/text → 400; bad JSON → 400 (no spawn)", async () => {
    const calls: string[][] = [];
    const spawn = (argv: string[]) => { calls.push(argv); return { exited: Promise.resolve(0) }; };
    expect((await post({ to: "eq3", text: "x" }, spawn)).status).toBe(400); // no room
    expect((await post({ room: "demo", text: "x" }, spawn)).status).toBe(400); // no lead
    expect((await post({ room: "demo", to: "eq3" }, spawn)).status).toBe(400); // no text
    const bad = await handleRoomSendRequest(new Request("http://x/api/room/send", { method: "POST", headers: { "content-type": "application/json" }, body: "nope" }), spawn);
    expect(bad.status).toBe(400);
    expect(calls).toEqual([]); // nothing delivered on a bad request
  });
});

describe("Brainstorm Room artifact routes (kobo-241 — open/close/reopen/thread)", () => {
  let dir: string; const prev = process.env.MAW_DATA_DIR;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "maw-roomroute-")); process.env.MAW_DATA_DIR = dir; });
  afterEach(() => { if (prev === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

  const openR = (b: unknown) => handleRoomOpenRequest(new Request("http://x/api/room/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const closeR = (b: unknown) => handleRoomCloseRequest(new Request("http://x/api/room/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const reopenR = (b: unknown) => handleRoomReopenRequest(new Request("http://x/api/room/reopen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));
  const thread = (q: string) => handleRoomThreadRequest(new Request("http://x/api/room/thread?" + q));

  test("open → thread persists → close → reopen reloads the full thread", async () => {
    const o = await openR({ company: "kobo", room: "demo", topic: "what to build" });
    expect(o.status).toBe(200);
    expect(((await o.json()) as { room: { status: string; topic: string } }).room).toMatchObject({ status: "open", topic: "what to build" });
    appendRoomMessage("kobo", "demo", { id: "m1", from: "web", text: "hi", ts: 1 }); // simulate a captured turn
    // thread read returns the persisted artifact
    const t = await thread("company=kobo&room=demo").json() as { ok: boolean; room: { messages: unknown[]; status: string } };
    expect(t.room.messages).toHaveLength(1);
    // close keeps the thread
    const closed = await (await closeR({ company: "kobo", room: "demo" })).json() as { room: { status: string } };
    expect(closed.room.status).toBe("closed");
    // reopen reloads it
    const re = await (await reopenR({ company: "kobo", room: "demo" })).json() as { room: { status: string; messages: unknown[] } };
    expect(re.room.status).toBe("open");
    expect(re.room.messages).toHaveLength(1);
  });

  test("thread without room → the room list; guards: missing fields → 400/404", async () => {
    await openR({ company: "kobo", room: "a", topic: "ta" });
    const list = await thread("company=kobo").json() as { ok: boolean; rooms: Array<{ id: string }> };
    expect(list.rooms.map((r) => r.id)).toEqual(["a"]);
    expect(thread("").status).toBe(400); // no company
    expect((await closeR({ company: "kobo", room: "ghost" })).status).toBe(404); // absent room
    expect((await openR({ company: "kobo" })).status).toBe(400); // no room
  });
});
