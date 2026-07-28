/**
 * kobo-586 — a `conversation` worklog entry's own oracle/pane is who RECEIVED
 * the prompt (UserPromptSubmit fires on the receiving pane), not who spoke.
 * When the summary carries a `[node:oracle]` sender tag, the rendered line
 * must show both roles distinctly. These tests mechanically extract sender vs
 * receiver from the render OUTPUT (never a hardcoded full-string compare —
 * that would pin a copy of the format, not the actual sender/receiver split,
 * the exact trap kobo-581's review caught) so a regression that re-merges the
 * two names back together is guaranteed to fail one of these, not just look
 * different.
 */

import { describe, expect, test } from "bun:test";
import { renderLines, renderTimeline } from "./render";
import { parseSignedPrefix } from "../../commands/shared/comm-send";
import type { WorklogEntry } from "./types";

function conversationEntry(overrides: Partial<WorklogEntry> = {}): WorklogEntry {
  return {
    ts: 1700000000000,
    iso: "2026-01-01T10:08:00.000Z",
    oracle: "eq3",
    pane: "0",
    kind: "conversation",
    summary: "hello",
    ...overrides,
  };
}

describe("worklog render — sender vs receiver (kobo-586)", () => {
  // The real kobo-586 near-miss shape: eq3.0 (lead) is the RECEIVER of a hey
  // from thawanban, about cards eq3's OWN conductor opened — reading the old
  // render, eq3.0 looks like the speaker of its own message.
  test("a hey-delivered conversation line splits into a real sender and a real receiver, mechanically", () => {
    const e = conversationEntry({
      oracle: "eq3", pane: "0",
      summary: "[m5:thawanban] ก้อนนี้ไม่ใช่ของผม",
    });
    const [rendered] = renderLines([e]);

    const arrowIdx = rendered.indexOf(" → ");
    expect(arrowIdx).toBeGreaterThan(-1); // sender/receiver separator present

    const beforeArrow = rendered.slice(0, arrowIdx);
    const afterArrow = rendered.slice(arrowIdx + " → ".length);

    // sender extracted from the TAG (not from the entry's own oracle field)
    expect(beforeArrow.endsWith("m5:thawanban")).toBe(true);
    // receiver extracted from the entry's own oracle+pane (the real recipient)
    expect(afterArrow.startsWith("eq3.0")).toBe(true);
    // the two slices must be genuinely distinct identities, not the same
    // string appearing twice — proves this is a real split, not decoration
    expect(beforeArrow).not.toContain("eq3");
    expect(afterArrow).not.toContain("thawanban");
    // the message BODY (after the tag) must still be present, tag stripped once
    expect(rendered).toContain("ก้อนนี้ไม่ใช่ของผม");
    expect(rendered.indexOf("[m5:thawanban]")).toBe(-1); // raw bracket form doesn't leak through twice
  });

  // Control: a genuinely human-typed / self-authored prompt (no hey involved)
  // carries no sender tag — must render exactly as before, no phantom arrow.
  test("a prompt with no sender tag renders unchanged — no arrow invented", () => {
    const e = conversationEntry({ oracle: "worker", pane: "1", summary: "just do the thing" });
    const [rendered] = renderLines([e]);
    expect(rendered).not.toContain(" → ");
    expect(rendered).toContain("worker.1");
    expect(rendered).toContain("just do the thing");
  });

  // Non-conversation kinds (tool/pr-*/claim/etc.) are always self-authored —
  // even if a summary happened to start with bracket-shaped text, it must
  // never be mistaken for a sender tag (only `conversation` can carry one,
  // per significant.ts — everything else is a direct, non-delivered action).
  test("a non-conversation entry never gets sender/receiver splitting, even with bracket-shaped text", () => {
    const e = conversationEntry({ kind: "tool", summary: "[weird] git push origin x" });
    const [rendered] = renderLines([e]);
    expect(rendered).not.toContain(" → ");
    expect(rendered).toContain("[weird] git push origin x");
  });

  // Back-compat: an old entry with no `pane` still renders (bare oracle name
  // as receiver) — must not throw, must not fabricate a pane it doesn't know.
  test("a tagged entry with no pane on the receiver still splits correctly (back-compat)", () => {
    const e = conversationEntry({ oracle: "somsri", pane: undefined, summary: "[m5:eq3] ping" });
    const [rendered] = renderLines([e]);
    const arrowIdx = rendered.indexOf(" → ");
    expect(arrowIdx).toBeGreaterThan(-1);
    expect(rendered.slice(arrowIdx + " → ".length).startsWith("somsri")).toBe(true);
    expect(rendered.slice(arrowIdx + " → ".length)).not.toContain("somsri.");
  });

  // kobo-586 AC 3: a clipped (>160 char) summary must still read as an
  // activity label, not a followable command — the existing MAX_SUMMARY clip
  // (significant.ts) already ends a truncated summary in "…"; pin that this
  // marker survives all the way into the rendered line, tag or no tag. Not
  // touching the 160 cutoff itself (out of scope) — this only pins the
  // truncation marker isn't silently lost by the sender/receiver rework.
  test("a truncated summary's ellipsis marker survives into the rendered line", () => {
    const clipped = "a".repeat(159) + "…"; // shape significant.ts's clip() produces
    const untagged = conversationEntry({ summary: clipped });
    expect(renderLines([untagged])[0].endsWith("…")).toBe(true);

    const tagged = conversationEntry({ summary: `[m5:eq3] ${clipped}` });
    expect(renderLines([tagged])[0].endsWith("…")).toBe(true);
  });

  test("renderTimeline joins the same per-line split, not a separate code path", () => {
    const e = conversationEntry({ oracle: "eq3", pane: "0", summary: "[m5:thawanban] hi" });
    const timeline = renderTimeline([e]);
    expect(timeline).toContain("m5:thawanban → eq3.0");
  });
});

// kobo-586 round 3 — eq3's own AC, 3 mandatory points (①②③). A crew cell has
// several panes of ONE oracle (conductor/lead/reviewer/worker); the ROLE typed
// after the sender is what actually distinguishes them — 837 real worklog rows
// carry this shape (`[m5:eq3 conductor]`, `[m5:eq3 lead %0]`, ...). ② and ③ are
// the two failure modes that "pass silently" to a glance: the role text quietly
// disappearing, or the closing `]` leaking into the message body.
describe("worklog render — sender role badge, distinct from the message body (kobo-586 round 3)", () => {
  // AC ①: the SENDER captured is node:oracle only — "conductor" must never end
  // up glued onto the oracle name as part of the sender identity itself.
  test("① sender is node:oracle only — the role never becomes part of the sender string", () => {
    const e = conversationEntry({ summary: "[m5:eq3 conductor] Tony ขอเล่า flow case-study" });
    const [rendered] = renderLines([e]);
    const arrowIdx = rendered.indexOf(" → ");
    const beforeArrow = rendered.slice(0, arrowIdx);
    expect(beforeArrow).toContain("m5:eq3");
    expect(beforeArrow).not.toContain("m5:eq3 conductor"); // role is not glued onto the sender id
  });

  // AC ②: the role must SURVIVE (not silently disappear) and must render as its
  // own badge, NEVER get concatenated into the message body text (`tag.rest`).
  test("② role survives as its own badge — does not vanish, does not flow into the message body", () => {
    const e = conversationEntry({ summary: "[m5:eq3 conductor] Tony ขอเล่า flow case-study" });
    const [rendered] = renderLines([e]);
    expect(rendered).toContain("(conductor)"); // the role badge itself, not lost
    const bodyIdx = rendered.indexOf("Tony ขอเล่า flow case-study");
    expect(bodyIdx).toBeGreaterThan(-1); // real body text present
    expect(rendered.slice(0, bodyIdx)).not.toMatch(/conductor\s*Tony/); // role never glued directly onto the body
  });

  test("② a multi-word role (\"lead %0\") survives whole, not truncated at the first space", () => {
    const e = conversationEntry({ summary: "[m5:eq3 lead %0] promote pm1" });
    const [rendered] = renderLines([e]);
    expect(rendered).toContain("(lead %0)");
    expect(rendered).toContain("promote pm1");
  });

  // AC ③: the closing `]` must NEVER leak into the message body — the exact
  // trap of a role-capture group that doesn't bound tightly at `]`.
  test("③ the closing ] never leaks into the message body, with or without a role", () => {
    const withRole = conversationEntry({ summary: "[m5:eq3 conductor] hello there" });
    expect(renderLines([withRole])[0]).not.toContain("]");

    const withoutRole = conversationEntry({ summary: "[m5:eq3] hello there" });
    expect(renderLines([withoutRole])[0]).not.toContain("]");
  });

  // No role present (plain `[node:oracle]`) — no badge, no stray parens, output
  // unchanged from before this round (regression guard on the common case).
  test("no role present → no badge rendered at all, not even empty parens", () => {
    const e = conversationEntry({ summary: "[m5:eq3] ping" });
    const [rendered] = renderLines([e]);
    expect(rendered).not.toContain("()");
    expect(rendered).toContain("m5:eq3 → ");
  });
});

describe("parseSignedPrefix — role capture (kobo-586 round 3)", () => {
  test("splits oracle (first word) from role (everything else inside the brackets)", () => {
    expect(parseSignedPrefix("[m5:eq3 conductor] hi")).toEqual({ node: "m5", oracle: "eq3", role: "conductor", rest: "hi" });
    expect(parseSignedPrefix("[m5:eq3 lead %0] hi")).toEqual({ node: "m5", oracle: "eq3", role: "lead %0", rest: "hi" });
    expect(parseSignedPrefix("[m5:eq3] hi")).toEqual({ node: "m5", oracle: "eq3", role: undefined, rest: "hi" });
  });

  test("the closing ] is consumed by the match, captured by neither group — cannot structurally leak into rest", () => {
    const withRole = parseSignedPrefix("[m5:eq3 conductor] rest text")!;
    expect(withRole.role).not.toContain("]");
    expect(withRole.rest).not.toContain("]");
    const withoutRole = parseSignedPrefix("[m5:eq3] rest text")!;
    expect(withoutRole.rest).not.toContain("]");
  });

  // kobo-586 round 3 — a role-capture group without `[^\]]` bounding (e.g. a
  // naive `(\s.*)?` instead of `(\s[^\]]*)?`) would still PASS the test above
  // (no other `]` in that input to expose the difference): a greedy `.*\]`
  // backtracks to the LAST `]` in the string, so it only misbehaves when the
  // message BODY itself contains a `]` after the tag closes — exactly the
  // case a real message quoting code/JSON/a markdown link would hit.
  test("③ the closing ] must bind to the TAG's own bracket, not backtrack into a ] later in the body", () => {
    const parsed = parseSignedPrefix("[m5:eq3 conductor] see kobo[123] for detail")!;
    expect(parsed.role).toBe("conductor"); // not "conductor] see kobo[123"
    expect(parsed.rest).toBe("see kobo[123] for detail"); // body's own bracket stays intact
  });
});
