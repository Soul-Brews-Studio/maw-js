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
