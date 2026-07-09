import { describe, expect, test } from "bun:test";
import { roomTag, messageInRoom, roomSendArgs, handleRoomSendRequest } from "./route";

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
