import { describe, expect, test } from "bun:test";
import { roomHtml } from "./room";
import { isProtected } from "../lib/elysia-auth";

describe("Brainstorm Room view (kobo-245)", () => {
  const html = roomHtml();
  test("renders the round-trip wire: input box → /api/room/send, thread ← /api/feed", () => {
    expect(html).toContain("/api/room/send"); // send half (hey to lead)
    expect(html).toContain("/api/feed"); // render half (reply back, reused feed)
    expect(html).toContain('id="text"'); // the input box
    expect(html).toContain("[room:"); // scopes the thread by room tag
    expect(html).toContain("MessageSend"); // filters hey lifecycle events
  });
  test("no nested backtick breaks the single template literal (renders non-empty)", () => {
    expect(html.length).toBeGreaterThan(1000);
    expect(html).toContain("<!doctype html>");
  });
  test("POST /api/room/send is auth-protected (loopback bypasses, LAN must auth) — kobo-245 security", () => {
    expect(isProtected("/room/send", "POST")).toBe(true);
    expect(isProtected("/room/send", "GET")).toBe(false); // GET /room view stays public read
  });
});
