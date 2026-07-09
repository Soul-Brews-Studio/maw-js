import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseRoomId, stripRoomTag, onRoomFeedEvent } from "./listener";
import { openRoom, readRoom } from "./store";
import type { FeedEvent } from "../../lib/feed";

let dir: string; const prev = process.env.MAW_DATA_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "maw-roomlsn-")); process.env.MAW_DATA_DIR = dir; });
afterEach(() => { if (prev === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

const ev = (over: Partial<FeedEvent> & { data?: unknown }): FeedEvent => ({
  timestamp: "x", oracle: "web", host: "local", event: "MessageSend", project: "", sessionId: "", message: "", ts: 1, ...over,
} as FeedEvent);

describe("room feed listener (kobo-241 — persist turns off the SAME hey feed events)", () => {
  test("parseRoomId / stripRoomTag", () => {
    expect(parseRoomId("[room:demo] hi")).toBe("demo");
    expect(parseRoomId("no tag")).toBeNull();
    expect(stripRoomTag("[room:demo] hello there")).toBe("hello there");
    expect(stripRoomTag(undefined)).toBe("");
  });

  test("appends both directions to the artifact, dedups by message id, ignores non-room + unopened", () => {
    openRoom("kobo", "demo", "t");
    // web send (MessageSend, outbound) → appended
    expect(onRoomFeedEvent(ev({ event: "MessageSend", data: { id: "m1", from: "web", to: "eq3", text: "[room:demo] what next?" }, ts: 1 }))).toBe(true);
    // same message re-emitted (queued→delivered) → dedup, no double
    expect(onRoomFeedEvent(ev({ event: "MessageDeliver", data: { id: "m1", from: "web", to: "eq3", text: "[room:demo] what next?" }, ts: 1 }))).toBe(true);
    // lead reply → appended
    expect(onRoomFeedEvent(ev({ event: "MessageSend", data: { id: "m2", from: "eq3", to: "web", text: "[room:demo] core wire first" }, ts: 2 }))).toBe(true);
    // a non-message feed event → ignored
    expect(onRoomFeedEvent(ev({ event: "Notification", data: { id: "n", text: "[room:demo] noise" } }))).toBe(false);
    // a tagged message for an UNOPENED room → ignored (no artifact minted)
    expect(onRoomFeedEvent(ev({ event: "MessageSend", data: { id: "m3", from: "x", text: "[room:ghost] stray" } }))).toBe(false);

    const room = readRoom("kobo", "demo")!;
    expect(room.messages.map((m) => [m.from, m.text])).toEqual([["web", "what next?"], ["eq3", "core wire first"]]); // stripped, deduped, ordered
  });

  test("normalizes from to the bare identity: web:web → web, m5:eq3 → eq3 (kobo-248 attribution)", () => {
    openRoom("kobo", "attr", "t");
    // web turn now carries the web:<author> sender (kobo-248), not the host oracle
    onRoomFeedEvent(ev({ event: "MessageSend", data: { id: "w1", from: "web:web", to: "eq3", text: "[room:attr] ตอบมาหน่อย" }, ts: 1 }));
    // lead reply carries the host-oracle display m5:eq3 → normalized to eq3
    onRoomFeedEvent(ev({ event: "MessageSend", data: { id: "l1", from: "m5:eq3", to: "web", text: "[room:attr] on it" }, ts: 2 }));
    const room = readRoom("kobo", "attr")!;
    expect(room.messages.map((m) => m.from)).toEqual(["web", "eq3"]); // human vs teammate, distinguishable
  });
});
