import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openRoom, closeRoom, reopenRoom, appendRoomMessage, readRoom, listRooms, findRoomCompany, roomFilePath } from "./store";
import { taskFilePath } from "../tasks/store";

let dir: string; const prev = process.env.MAW_DATA_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "maw-room-")); process.env.MAW_DATA_DIR = dir; });
afterEach(() => { if (prev === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

describe("room artifact store (kobo-241 — off-card, file-per-room)", () => {
  test("openRoom creates an OFF-CARD artifact under rooms/, NOT the kanban tasks/ dir", () => {
    const r = openRoom("kobo", "demo", "what to build");
    expect(r).toMatchObject({ id: "demo", company: "kobo", topic: "what to build", status: "open", messages: [] });
    expect(existsSync(roomFilePath("kobo", "demo"))).toBe(true);
    expect(roomFilePath("kobo", "demo")).toContain("/rooms/"); // NOT /tasks/
    expect(existsSync(taskFilePath("kobo", "demo"))).toBe(false); // never a kanban card
  });

  test("close / reopen flip status but PRESERVE the thread (persist + reload)", () => {
    openRoom("kobo", "r1", "topic");
    appendRoomMessage("kobo", "r1", { id: "m1", from: "web", text: "hi lead", ts: 1 });
    expect(closeRoom("kobo", "r1")!.status).toBe("closed");
    expect(readRoom("kobo", "r1")!.messages).toHaveLength(1); // thread survives close
    const re = reopenRoom("kobo", "r1")!;
    expect(re.status).toBe("open");
    expect(re.messages).toHaveLength(1); // reopen reloads the full thread
    expect(re.topic).toBe("topic"); // reopen keeps the topic
  });

  test("appendRoomMessage is idempotent by source id (a hey emits >1 feed event)", () => {
    openRoom("kobo", "r2", "t");
    appendRoomMessage("kobo", "r2", { id: "mA", from: "web", text: "q", ts: 1 });
    appendRoomMessage("kobo", "r2", { id: "mA", from: "web", text: "q", ts: 1 }); // dup → skipped
    appendRoomMessage("kobo", "r2", { id: "mB", from: "eq3", text: "a", ts: 2 });
    expect(readRoom("kobo", "r2")!.messages.map((m) => m.id)).toEqual(["mA", "mB"]);
  });

  test("appendRoomMessage on an UNOPENED room → null (stray traffic never mints an artifact)", () => {
    expect(appendRoomMessage("kobo", "ghost", { id: "x", from: "a", text: "b", ts: 1 })).toBeNull();
    expect(existsSync(roomFilePath("kobo", "ghost"))).toBe(false);
  });

  test("reopen of an absent room → null; findRoomCompany resolves the owning company", () => {
    expect(reopenRoom("kobo", "nope")).toBeNull();
    openRoom("kobo", "here", "t");
    expect(findRoomCompany("here")).toBe("kobo");
    expect(findRoomCompany("nowhere")).toBeNull();
  });

  test("listRooms returns a company's rooms newest-first (id/topic/status)", () => {
    openRoom("kobo", "a", "ta"); openRoom("kobo", "b", "tb");
    const ids = listRooms("kobo").map((r) => r.id);
    expect(ids.sort()).toEqual(["a", "b"]);
    expect(listRooms("other")).toEqual([]);
  });
});
