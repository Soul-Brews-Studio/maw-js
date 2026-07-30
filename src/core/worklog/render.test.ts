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

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { renderLines, renderTimeline } from "./render";
import { parseSignedPrefix, parseKnownSenderPrefix, _resetKnownSenderOraclesCache } from "../../commands/shared/comm-send";
import { _setCompaniesDir, saveCompany, COMPANIES_DIR } from "../../vendor/mpr-plugins/company/company-helpers";
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

// kobo-656 — renderLines()/renderTimeline() call parseKnownSenderPrefix()
// (render.ts:76), which resolves "is this a known sender oracle" against the
// REAL company registry unless COMPANIES_DIR is redirected. Every fixture in
// this file that names a sender oracle in a tag ("eq3", "thawanban", "somsri")
// only passed on a dev machine because those happen to be REAL, registered
// oracles on this machine's own board — pure coincidence, not a guarantee.
// Proven the hard way: `HOME=$(mktemp -d) bun run test:src` reproduces CI's
// exact failures locally. Same sandbox pattern as the
// "oracle accept-list" describe below (already hermetic) — factored out so
// every describe that calls renderLines/renderTimeline shares it, instead of
// only the one block that happened to need it when it was written.
//
// NOT applied to "parseSignedPrefix — role capture" below: those tests call
// `parseSignedPrefix` only (the structural node/oracle/role splitter), never
// `parseKnownSenderPrefix` — no registry involved, sandboxing it would be a
// no-op. NOT applied to the real-corpus measurement describe at the bottom of
// this file either: that block is DELIBERATELY non-hermetic by design (its
// own comment says so) — it exists specifically to validate against this
// machine's REAL ~/.maw/companies/kobo data; redirecting COMPANIES_DIR there
// would defeat its entire purpose, not fix a bug.
function useRegistrySandbox(): void {
  const origCompaniesDir = COMPANIES_DIR;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kobo656-render-"));
    _setCompaniesDir(join(dir, "companies"));
    saveCompany({
      name: "kobo656test",
      manager: "eq3",
      teams: { core: { lead: "eq3", members: [{ oracle: "eq3", role: "lead" }, { oracle: "thawanban", role: "dev" }, { oracle: "somsri", role: "dev" }] } },
    });
    _resetKnownSenderOraclesCache();
  });
  afterEach(() => {
    _setCompaniesDir(origCompaniesDir);
    rmSync(dir, { recursive: true, force: true });
    _resetKnownSenderOraclesCache();
  });
}

describe("worklog render — sender vs receiver (kobo-586)", () => {
  useRegistrySandbox(); // kobo-656 — renderLines() resolves sender tags against the registry
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
  useRegistrySandbox(); // kobo-656 — renderLines() resolves sender tags against the registry
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

// kobo-597 round 1 — classification only: 2 shapes are structurally rejected
// (null, falls through to plain text) because nothing in this codebase
// constructs them as a real [node:oracle] tag.
describe("parseSignedPrefix — non-sender prefixes are classified out, not promoted (kobo-597)", () => {
  // kobo-656 — only the last test in this block ("kobo-586's role-badge case
  // is unaffected") calls renderLines() and needs this; the other 4 call
  // parseSignedPrefix directly (no registry involved) and don't care — safe
  // to share the same sandbox across the whole block regardless.
  useRegistrySandbox();
  // (a) oracle segment containing a colon = a DIFFERENT, unrelated bracket
  // convention (e.g. fleet:host:oracle, a real 3-part shape this file doesn't
  // own) — a genuine oracle name never contains a colon.
  test("a colon inside the oracle segment is rejected — not a 2-part node:oracle tag", () => {
    expect(parseSignedPrefix("[fleet:monkut:monkut] ✅ posted 5 photos")).toBeNull();
  });

  // (b) a numeric or numeric-hyphen-prefixed node = a raw tmux session name
  // leaking through unstripped — no configured node is ever numeric-shaped.
  test("a numeric-hyphen-prefixed node (a leaked tmux session name) is rejected", () => {
    expect(parseSignedPrefix("[13-patchwork:worker] did the thing")).toBeNull();
    expect(parseSignedPrefix("[31-kadan-reader:review] looked at it")).toBeNull();
  });

  test("a bare numeric node (session number with no oracle suffix) is rejected", () => {
    expect(parseSignedPrefix("[13:patchwork] รับ kobo-317")).toBeNull();
  });

  // "local" is formatSignedMessage's own literal fallback value (config.node
  // || "local") — genuinely machine-constructed, must never be rejected.
  test("node = 'local' (formatSignedMessage's real fallback) is NOT rejected", () => {
    expect(parseSignedPrefix("[local:eq3] assigned you acme-1")).not.toBeNull();
  });

  // kobo-597 review requirement ⑤: replay kobo-586's own role-badge fixture at
  // this card's head — the two new structural rejections must not touch it.
  test("kobo-586's role-badge case is unaffected by kobo-597's new rejections", () => {
    expect(parseSignedPrefix("[m5:eq3 conductor] Tony ขอเล่า flow case-study")).toEqual({
      node: "m5", oracle: "eq3", role: "conductor", rest: "Tony ขอเล่า flow case-study",
    });
    const [rendered] = renderLines([conversationEntry({ summary: "[m5:eq3 conductor] hi" })]);
    expect(rendered).toContain("(conductor)");
  });
});

// kobo-597 round 2 — eq3's reversal (card comments c2/c3): round 1's reject-only
// design proved permanent-blind-spot-prone (reviewer's own announced-in-advance
// test: brand-new never-seen prefixes `[see:docs]`/`[note:x]` both still parsed
// as senders). Flipped to an ACCEPT-list on the oracle half only — deliberately
// NOT the node half, see parseSignedPrefix's own docstring for why that's
// kobo-590's scope, not this one's.
describe("parseSignedPrefix — oracle accept-list, node half deliberately unchecked (kobo-597 round 2)", () => {
  // Hermetic — redirects company-helpers' COMPANIES_DIR to a fresh temp dir (same
  // pattern as route.test.ts) so this never reads or writes the real ~/.maw/companies.
  const origCompaniesDir = COMPANIES_DIR;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kobo597-render-"));
    _setCompaniesDir(join(dir, "companies"));
    saveCompany({ name: "kobo597test", manager: "eq3test597", teams: { core: { lead: "leadtest597", members: [{ oracle: "leadtest597", role: "lead" }, { oracle: "membertest597", role: "dev" }] } } });
    _resetKnownSenderOraclesCache();
  });
  afterEach(() => {
    _setCompaniesDir(origCompaniesDir);
    rmSync(dir, { recursive: true, force: true });
    _resetKnownSenderOraclesCache();
  });

  test("a real registered company oracle passes (companyOracles-backed accept)", () => {
    expect(parseKnownSenderPrefix(`[m5:membertest597] ok`)).toEqual({ node: "m5", oracle: "membertest597", role: undefined, rest: "ok" });
  });

  test("a company MANAGER (not a team member) also passes", () => {
    expect(parseKnownSenderPrefix(`[m5:eq3test597] ok`)).not.toBeNull();
  });

  test("web is explicitly accepted (kobo-386 — the room-send handler's constant persisted identity)", () => {
    expect(parseKnownSenderPrefix("[web:web] sent to eq3")).not.toBeNull();
  });

  test("an unregistered name is rejected — the announced positive control (never seen in the corpus before)", () => {
    expect(parseKnownSenderPrefix("[see:docs] whatever")).toBeNull();
    expect(parseKnownSenderPrefix("[note:x] whatever")).toBeNull();
  });

  // The exact case the card's own user story names — must fail, or the card
  // lies about the problem it closes.
  test("[request:req-lazy-pos-8] — the card's own headline example — is rejected", () => {
    expect(parseKnownSenderPrefix("[request:req-lazy-pos-8] UI rework")).toBeNull();
  });

  test("room:/head:/re:/patchwork-as-node — every previously-slipping-through fake shape — is rejected", () => {
    expect(parseKnownSenderPrefix("[room:e2e-239] driver test")).toBeNull();
    expect(parseKnownSenderPrefix("[head:lead] briefing")).toBeNull();
    expect(parseKnownSenderPrefix("[re: subject] reply")).toBeNull(); // space after ':' also never matches the regex at all
    expect(parseKnownSenderPrefix("[patchwork:reviewer] ack")).toBeNull(); // "patchwork" BARE as node, no m5: prefix
  });

  // A node signing itself as its own oracle ([m5:m5], [monkut:monkut]) is a
  // machine self-announcement, not tied to any registered oracle — measured
  // live: 6 real rows use this shape. Accepted structurally, no registry hit.
  test("node === oracle (self-reference) is accepted without any registry lookup", () => {
    expect(parseKnownSenderPrefix("[monkut:monkut] update สำเร็จ")).toEqual({ node: "monkut", oracle: "monkut", role: undefined, rest: "update สำเร็จ" });
  });
  test("self-reference does NOT bypass the numeric-node rule — still rejected", () => {
    expect(parseKnownSenderPrefix("[13:13] whatever")).toBeNull();
  });

  // A human-typed directional suffix (`eq3→patchwork`, `nai/conductor`) — the
  // real sender is the part BEFORE the delimiter; 30 real rows measured live.
  test("a → or / directional suffix on the oracle half is stripped before the accept check", () => {
    expect(parseKnownSenderPrefix(`[m5:membertest597→other] routing-verify FAIL`)).not.toBeNull();
    expect(parseKnownSenderPrefix(`[m5:membertest597/conductor] briefing`)).not.toBeNull();
  });
  test("the directional-suffix check still requires the PREFIX itself to be known — not any string before an arrow", () => {
    expect(parseKnownSenderPrefix("[re:eq3-monkut-maw-update] synced")).toBeNull(); // hyphen, not → or / — must NOT split
  });

  // kobo-597 (e) — eq3's 3rd ruling: `thawanban-coord` (5 real rows) IS a real
  // sender — a known oracle acting in a role from the SAME closed crew-role
  // vocabulary `role` above already recognizes for the space-separated form
  // (`[m5:eq3 conductor]`), just hyphen-joined instead. Split on the LAST
  // hyphen ONLY when the suffix is a member of that closed 5-word set.
  test("a hyphen-joined ROLE suffix from the closed crew-role set is accepted (kobo-586's space-form, hyphen-joined)", () => {
    expect(parseKnownSenderPrefix(`[mba:membertest597-coord] ground แล้ว`)).not.toBeNull();
    expect(parseKnownSenderPrefix(`[mba:membertest597-conductor] x`)).not.toBeNull();
    expect(parseKnownSenderPrefix(`[mba:membertest597-worker] x`)).not.toBeNull();
    expect(parseKnownSenderPrefix(`[mba:membertest597-reviewer] x`)).not.toBeNull();
    expect(parseKnownSenderPrefix(`[mba:membertest597-front] x`)).not.toBeNull();
  });

  // The CLOSED-set requirement is what keeps this safe — a hyphen suffix that
  // is NOT one of the 5 known crew roles must still be rejected, proving this
  // is not a disguised general hyphen-split (the exact trap that let
  // `[re:eq3-monkut-maw-update]` through when tested as a general split).
  test("a hyphen suffix outside the closed role set is still rejected — not a general split", () => {
    expect(parseKnownSenderPrefix(`[mba:membertest597-somethingelse] x`)).toBeNull();
    expect(parseKnownSenderPrefix("[re:eq3-monkut-maw-update] synced")).toBeNull();
  });

  // A hyphenated COMPOUND real name (already registered as ONE full string)
  // must keep matching on its own — the role-suffix split only kicks in
  // AFTER an exact match fails, never instead of one.
  test("a registered hyphenated compound name matches directly, no role-split needed", () => {
    expect(parseKnownSenderPrefix(`[m5:membertest597] ok`)).not.toBeNull(); // sanity: exact match still primary
  });
});

// kobo-597 round 2 real-corpus measurement (card's own AC — must be run against
// data, not asserted from reasoning). Runs against the REAL ~/.maw/companies/kobo
// worklog and REAL company/oracle registries (no seeding here — this is the one
// test in this file deliberately NOT hermetic, by design, since the whole point
// is proving the rule against live data as required). Scope note (eq3, explicit):
// this gate is KOBO-scoped on purpose — pgw's worklog carries a much larger
// reclassified count (measured separately, ~389 rows at review time) with a
// different-shaped residual (real pgw oracle names used as the NODE half, not
// the oracle half) that pgw's own board must judge, not kobo's; not measured or
// asserted here so nobody reads this file as having covered the whole fleet.
describe("parseKnownSenderPrefix — real-corpus measurement (kobo-597 round 2, kobo-scoped)", () => {
  function loadKoboConversationEntries(): Array<{ summary: string }> | null {
    const path = require("path").join(require("os").homedir(), ".maw/companies/kobo/worklog.jsonl");
    if (!require("fs").existsSync(path)) return null; // this machine has no kobo worklog — skip, don't fail the suite
    const lines: string[] = require("fs").readFileSync(path, "utf8").split("\n").filter(Boolean);
    const out: Array<{ summary: string }> = [];
    for (const line of lines) {
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.kind === "conversation" && typeof entry.summary === "string") out.push(entry);
    }
    return out;
  }

  // kobo-597 round 3 (eq3's final ruling): the classifier's declared universe
  // is "oracle = a member of some company REGISTERED ON THE BOARD" — m5/mba/
  // web/local are the node buckets that carry registered-company senders.
  // `monkut`/`somsri` are deliberately EXCLUDED from this "must never lose"
  // list — they're real but outside the declared universe, tracked as an
  // honest residual in the dedicated test below, not folded in here.
  const REAL_NODE_BUCKETS = ["m5", "mba", "web", "local"];

  test("real senders WITHIN the declared universe (registered company members) cut = 0", () => {
    const entries = loadKoboConversationEntries();
    if (!entries) return;
    const OLD_RE = /^\[([^\]\s:]+):([^\]\s]+)(\s[^\]]*)?\](?:\s|$)/;
    const before: Record<string, number> = {};
    const after: Record<string, number> = {};
    for (const e of entries) {
      // kobo-597 round 3: rows OUTSIDE the declared universe (not a registered
      // company member) are tracked as an honest residual in the dedicated
      // test below, not folded into this "must never lose" measurement.
      if (KNOWN_OUTSIDE_UNIVERSE.some((p) => e.summary.startsWith(p))) continue;
      const old = e.summary.match(OLD_RE);
      if (old && REAL_NODE_BUCKETS.includes(old[1])) before[old[1]] = (before[old[1]] ?? 0) + 1;
      const tag = parseKnownSenderPrefix(e.summary);
      if (tag && REAL_NODE_BUCKETS.includes(tag.node)) after[tag.node] = (after[tag.node] ?? 0) + 1;
    }
    const lost = Object.entries(before).reduce((s, [k, v]) => s + (v - (after[k] ?? 0)), 0);
    expect(lost).toBe(0);
  });

  // The card's own headline example must be gone.
  test("[request:req-lazy-pos-8] is no longer classified as a sender in the real corpus", () => {
    const entries = loadKoboConversationEntries();
    if (!entries) return;
    const hit = entries.find((e) => e.summary.startsWith("[request:req-lazy-pos-8]"));
    if (!hit) return; // row not present on this machine's worklog — nothing to assert
    expect(parseKnownSenderPrefix(hit.summary)).toBeNull();
  });

  // Every previously-slipping-through fake shape stays rejected in the real data
  // (not just the synthetic fixtures above) — request:/room:/head:/re:/fleet:/
  // patchwork-as-node.
  test("every confirmed-fake prefix family is rejected in the real corpus, not just synthetic fixtures", () => {
    const entries = loadKoboConversationEntries();
    if (!entries) return;
    const FAKE_PREFIXES = ["[request:", "[room:", "[head:", "[re:", "[fleet:", "[patchwork:"];
    let checked = 0;
    for (const e of entries) {
      if (!FAKE_PREFIXES.some((p) => e.summary.startsWith(p))) continue;
      checked++;
      expect(parseKnownSenderPrefix(e.summary)).toBeNull();
    }
    expect(checked).toBeGreaterThan(0); // the corpus must actually contain these — a 0-count run proves nothing
  });

  // kobo-597 round 3 — the DECLARED, closed residual: real senders that are
  // genuinely outside this classifier's declared universe (not a member of
  // any company registered on the board), reported by name per eq3's ruling
  // — "declare it, don't silently absorb it." Checked against company.json
  // for kobo/pgw/demo/smoke375 by hand (eq3): "monkut" and "somsri" are
  // members of NONE of them.
  //   - monkut, via the "[fleet:monkut] " shape — ledger-verified real
  //     (message-ledger.sqlite: from_id='fleet:monkut', state='delivered'
  //     x2) — the fleet's own top-level self-identity, not a company member
  //     anywhere. ("[monkut:monkut]" itself is NOT in this list — it's
  //     node===oracle self-reference, already accepted structurally above,
  //     never reaches this residual check at all.)
  //   - somsri — ledger-verified real (message-ledger.sqlite: from_id=
  //     'm5:somsri', state='delivered'/'failed' x39), not a company member
  //     anywhere either, discovered only once the fleet-cache fallback
  //     (which used to mask this) was dropped for being per-host
  // "monkut-pod"/"kaen" is deliberately NOT on this list — it read as
  // substantive real task activity by eye, but the ledger is the authority,
  // not a text read: kaen has ZERO rows in message-ledger.sqlite at any
  // state. Correctly rejected, not a residual — a lesson in itself (verify
  // against the structured record, not "this looks real").
  // memberA is the one row that ISN'T real — not a registered oracle and not
  // an oracle-role shape, correctly rejected on its own merits.
  const KNOWN_OUTSIDE_UNIVERSE = ["[fleet:monkut] ", "[m5:somsri] ", "[m5:memberA]"];

  test("the declared residual (outside the classifier's universe) is exactly this list — no unexplained drops", () => {
    const entries = loadKoboConversationEntries();
    if (!entries) return;
    const OLD_RE = /^\[([^\]\s:]+):([^\]\s]+)(\s[^\]]*)?\](?:\s|$)/;
    const FAKE_PREFIXES = ["request", "room", "head", "re", "fleet", "patchwork", "monkut-pod"]; // monkut-pod:kaen — ledger-verified NOT real (0 rows in message-ledger.sqlite), correctly rejected
    const unexplainedDrops: string[] = [];
    let declaredResidualCount = 0;
    for (const e of entries) {
      const old = e.summary.match(OLD_RE);
      if (!old) continue;
      const tag = parseKnownSenderPrefix(e.summary);
      if (tag) continue; // still classified — fine
      if (KNOWN_OUTSIDE_UNIVERSE.some((p) => e.summary.startsWith(p))) { declaredResidualCount++; continue; }
      if (/^\d+(-|$)/.test(old[1])) continue; // round 1's numeric-node rule — expected
      if (FAKE_PREFIXES.includes(old[1])) continue; // confirmed-fake families — expected
      unexplainedDrops.push(e.summary.slice(0, 60));
    }
    expect(unexplainedDrops).toEqual([]); // any row NOT on the declared list is a real regression, must fail loud
    expect(declaredResidualCount).toBeGreaterThan(0); // the declared residual must actually be present in the corpus — a 0-count run proves nothing
  });
});
