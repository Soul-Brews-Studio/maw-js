import { describe, expect, test } from "bun:test";
import { roomHtml } from "./room";
import { isProtected } from "../lib/elysia-auth";

// kobo-258 — the /room page became a company-scoped 2-pane chat (UX spec eq3 2026-07-10):
// LEFT topic list · RIGHT thread, default partner = the company lead, 3-role attribution
// (you/lead/teammate) by pill + alignment + colour (a11y). The board is a single-file
// HTML+JS template (no runtime here), so pin the structural markers a refactor must keep.
describe("Brainstorm Room 2-pane chat view (kobo-258)", () => {
  const html = roomHtml();

  test("consumes the existing room engine endpoints (no new engine — view only)", () => {
    expect(html).toContain("/api/rooms"); // kobo-258 company-scoped list (topics + selector + lead)
    expect(html).toContain("/api/room/thread"); // persisted thread (kobo-241)
    expect(html).toContain("/api/room/send"); // hey to the lead (kobo-245/248)
    expect(html).toContain("/api/room/activity"); // who's-here strip (kobo-242)
    expect(html).toContain("/api/room/open"); // new topic
    expect(html).toContain("/api/room/distill"); // room → card (kobo-244)
    expect(html).toContain("/api/room/merge"); // consolidate (kobo-243)
    expect(html).toContain("/api/room/invite"); // kobo-260 pull a teammate in
    expect(html).not.toContain("/api/feed"); // never the ephemeral feed
  });

  test("kobo-260: invite affordance pulls a teammate in (reachable from the chat header)", () => {
    expect(html).toContain('id="inviteBtn"');
    expect(html).toContain("async function invite");
  });

  test("2-pane structure: company selector, topic list, thread, composer, lead label", () => {
    expect(html).toContain('id="company"'); // company selector (scope)
    expect(html).toContain('id="leadName"'); // "lead: <oracle>" — default partner
    expect(html).toContain('id="roomlist"'); // LEFT topic list
    expect(html).toContain('id="thread"'); // RIGHT conversation
    expect(html).toContain('id="text"'); // composer
    expect(html).toContain("class=\"app\""); // the 2-pane grid
  });

  test("default partner = the company lead (send targets `lead`, from the /api/rooms response)", () => {
    expect(html).toContain("body.lead"); // lead resolved server-side, carried in the list response
    expect(html).toContain("to: lead"); // the send defaults to the company lead
    expect(html).toContain("from: 'web'"); // web turn tagged human (kobo-248)
  });

  test("3-role attribution by pill + alignment + colour, not colour alone (a11y)", () => {
    expect(html).toContain(".bubble.you"); // human — right, sky
    expect(html).toContain(".bubble.lead"); // lead — left, green
    expect(html).toContain(".bubble.teammate"); // pulled-in teammate — left, violet
    expect(html).toContain("function roleOf"); // maps `from` → role (web→you, lead→lead)
    expect(html).toContain("function pillText"); // role-pill TEXT carries the role (colour-not-only)
    expect(html).toContain("align-self:flex-end"); // alignment also carries it
  });

  test("mobile single-pane slide + a11y basics", () => {
    expect(html).toContain("max-width:768px"); // mobile breakpoint
    expect(html).toContain("showchat"); // single-pane: topic list → slide to chat
    expect(html).toContain('aria-live="polite"'); // new messages announced
    expect(html).toContain(":focus-visible"); // keyboard focus ring
  });

  test("no nested backtick breaks the single template literal (renders non-empty)", () => {
    expect(html.length).toBeGreaterThan(1000);
    expect(html).toContain("<!doctype html>");
  });

  test("kobo-379: close/reopen affordance in the chat header, toggles the composer", () => {
    expect(html).toContain('id="closeBtn"');
    expect(html).toContain("/api/room/close");
    expect(html).toContain("/api/room/reopen");
    expect(html).toContain("function toggleRoomOpen");
    expect(html).toContain("function updateRoomControls");
    expect(html).toContain("$('text').disabled = !open"); // closed room disables reply
  });

  test("room data routes stay auth-protected (loopback bypasses, LAN must auth) — Rule 6", () => {
    expect(isProtected("/rooms", "GET")).toBe(true); // kobo-258: topic list is company-internal
    expect(isProtected("/room/thread", "GET")).toBe(true); // private conversation (kobo-241)
    expect(isProtected("/room/send", "POST")).toBe(true);
    expect(isProtected("/room/merge", "POST")).toBe(true);
    expect(isProtected("/room", "GET")).toBe(false); // the /room VIEW itself stays public read
  });
});
