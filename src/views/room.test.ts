import { describe, expect, test } from "bun:test";
import { roomHtml } from "./room";
import { isProtected } from "../lib/elysia-auth";

describe("Brainstorm Room view (kobo-245 wire + kobo-241 artifact)", () => {
  const html = roomHtml();
  test("wires send + the persisted-artifact lifecycle: send/open/close, thread ← /api/room/thread", () => {
    expect(html).toContain("/api/room/send"); // send half (hey to lead)
    expect(html).toContain("/api/room/thread"); // kobo-241: render from the off-card artifact, not the ephemeral feed
    expect(html).toContain("/api/room/open"); // open / reopen
    expect(html).toContain("/api/room/close"); // close (thread kept)
    expect(html).toContain('id="text"'); // the input box
    expect(html).toContain('id="company"'); // rooms are per-company
    expect(html).not.toContain("/api/feed"); // kobo-241: no longer renders from the ephemeral feed
  });
  test("no nested backtick breaks the single template literal (renders non-empty)", () => {
    expect(html.length).toBeGreaterThan(1000);
    expect(html).toContain("<!doctype html>");
  });
  test("all /room/* data routes are auth-protected (loopback bypasses, LAN must auth) — kobo-241 security", () => {
    expect(isProtected("/room/send", "POST")).toBe(true); // control op (hey delivery)
    expect(isProtected("/room/thread", "GET")).toBe(true); // reveals a private company conversation (Rule 6)
    expect(isProtected("/room/open", "POST")).toBe(true);
    expect(isProtected("/room/merge", "POST")).toBe(true); // kobo-243: merge writes artifacts → protected by the /room/ prefix
    expect(isProtected("/room", "GET")).toBe(false); // the /room VIEW itself stays public read
  });

  test("kobo-243 lead-driven merge: propose + human-confirm gate, no auto-merge", () => {
    expect(html).toContain("/api/room/merge"); // the merge endpoint
    expect(html).toContain("proposeMerge"); // lead proposes (never automatic)
    expect(html).toContain("window.confirm"); // a human OKs before anything is written
    expect(html).toContain("confirm: true"); // the server-side gate flag
    expect(html).toContain("tgt.name = 'mtarget'"); // one target room survives (radio group)
    expect(html).toContain("archived"); // sources kept, not deleted (Principle 1)
  });
});
