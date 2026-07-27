import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, statSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { toolSummary, eventToWorklog } from "./significant";
import { renderTimeline } from "./render";
import { pingOnMerge, pingCollision } from "./ping";
import { appendWorklog, readWorklog, openClaims, flushWorklog, worklogPath, _resetWorklogCache } from "./store";
import { handleWorklogRequest } from "./route";
import { tasksOverlap, collidingClaims, addClaim, releaseClaim } from "./claim";
import { buildInjectSlice } from "./slice";
import type { FeedEvent } from "../../lib/feed";
import type { WorklogEntry } from "./types";

// One data dir for the whole file; tests isolate via distinct company names.
beforeAll(() => {
  process.env.MAW_DATA_DIR = mkdtempSync(join(tmpdir(), "worklog-test-"));
});

function feed(p: Partial<FeedEvent>): FeedEvent {
  return {
    timestamp: "2026-06-22T10:05:00.000Z", oracle: "worker", host: "local",
    event: "PostToolUse", project: "repo", sessionId: "s1", message: "", ts: 1_000, ...p,
  } as FeedEvent;
}

describe("significant filter (filter b)", () => {
  it("keeps git/gh Bash, drops other shell + read-only", () => {
    expect(toolSummary("Bash", { command: "git push origin feat/x" })).toBe("git push origin feat/x");
    expect(toolSummary("Bash", { command: "gh pr merge 123" })).toBe("gh pr merge 123");
    expect(toolSummary("Bash", { command: "ls -la" })).toBeNull();
    expect(toolSummary("Edit", { file_path: "/a/b.ts" })).toBe("Edit /a/b.ts");
    expect(eventToWorklog(feed({ data: { tool_name: "Read", tool_input: { file_path: "/x" } } }))).toBeNull();
  });

  it("maps PostToolUse git → tool entry", () => {
    const e = eventToWorklog(feed({ data: { tool_name: "Bash", tool_input: { command: "git commit -m x" } } }));
    expect(e?.kind).toBe("tool");
    expect(e?.summary).toBe("git commit -m x");
  });

  it("maps UserPromptSubmit → conversation entry", () => {
    const e = eventToWorklog(feed({ event: "UserPromptSubmit", data: { prompt: "keep the hash field" } }));
    expect(e?.kind).toBe("conversation");
    expect(e?.summary).toBe("keep the hash field");
  });

  it("maps interrupt (Notification + kind:interrupt) → interrupt entry", () => {
    const e = eventToWorklog(feed({ event: "Notification", data: { kind: "interrupt", prompt: "no, keep the field" } }));
    expect(e?.kind).toBe("interrupt");
    expect(e?.summary).toContain("no, keep the field");
  });

  it("ignores pr-* Notification (poller writes those directly)", () => {
    expect(eventToWorklog(feed({ event: "Notification", data: { kind: "pr-merged", pr: 1 } }))).toBeNull();
  });

  it("stamps the pane index from data.pane WITHOUT touching oracle (company/scope safe)", () => {
    const e = eventToWorklog(feed({ oracle: "eq3", data: { tool_name: "Bash", tool_input: { command: "git status" }, pane: "1" } }));
    expect(e?.oracle).toBe("eq3"); // oracle string stays clean — feeds company/scope lookup
    expect(e?.pane).toBe("1");
  });

  it("distinguishes two panes of the SAME oracle (acceptance b)", () => {
    const p1 = eventToWorklog(feed({ oracle: "eq3", data: { tool_name: "Bash", tool_input: { command: "git log" }, pane: "1" } }));
    const p2 = eventToWorklog(feed({ oracle: "eq3", data: { tool_name: "Bash", tool_input: { command: "git log" }, pane: "2" } }));
    expect(p1?.pane).not.toBe(p2?.pane);
    expect(p1?.oracle).toBe(p2?.oracle); // same oracle, different pane
  });

  it("back-compat: no data.pane → no pane field (old capture format)", () => {
    const e = eventToWorklog(feed({ oracle: "eq3", data: { tool_name: "Bash", tool_input: { command: "git status" } } }));
    expect(e?.pane).toBeUndefined();
  });

  it("persists Stop as a durable per-pane idle entry keyed by paneId (kobo-109, decision B)", () => {
    const e = eventToWorklog(feed({ event: "Stop", oracle: "eq3", data: { paneId: "%40" } }));
    expect(e?.kind).toBe("idle");
    expect(e?.paneId).toBe("%40"); // idle joins by paneId (%N), the stable per-pane key
    expect(e?.pane).toBeUndefined(); // no display index on a Stop — idle is never a feed line
    expect(e?.oracle).toBe("eq3");
  });

  it("paneless Stop still yields an idle entry (non-tmux, no per-pane signal)", () => {
    const e = eventToWorklog(feed({ event: "Stop", oracle: "eq3" }));
    expect(e?.kind).toBe("idle");
    expect(e?.paneId).toBeUndefined();
  });

  it("Stop + data.error → kind 'error' (turn-ending API error, kobo-111)", () => {
    const e = eventToWorklog(feed({ event: "Stop", oracle: "eq3", data: { paneId: "%40", error: true } }));
    expect(e?.kind).toBe("error");
    expect(e?.paneId).toBe("%40"); // error joins by paneId like idle
    expect(e?.oracle).toBe("eq3");
  });

  it("Stop without data.error stays idle (mid-turn error that recovered)", () => {
    const e = eventToWorklog(feed({ event: "Stop", oracle: "eq3", data: { paneId: "%40" } }));
    expect(e?.kind).toBe("idle"); // only an explicit error flag trips 'error'
  });

  it("stamps paneId (%N join key) alongside pane (display index) on activity", () => {
    const e = eventToWorklog(feed({ oracle: "eq3", data: { tool_name: "Bash", tool_input: { command: "git status" }, pane: "1", paneId: "%40" } }));
    expect(e?.pane).toBe("1");    // display → oracle.1 in the feed
    expect(e?.paneId).toBe("%40"); // join → matches the presence file per-pane
  });

  it("SessionStart stays dropped (orientation, not a state transition)", () => {
    expect(eventToWorklog(feed({ event: "SessionStart" }))).toBeNull();
  });
});

describe("timeline render", () => {
  it("renders narrative incl conversation + merge attribution", () => {
    const out = renderTimeline([
      { ts: 1, iso: "2026-06-22T10:05:00.000Z", oracle: "w", kind: "conversation", summary: "Tony: keep field" },
      { ts: 2, iso: "2026-06-22T10:15:00.000Z", oracle: "w", kind: "pr-merged", summary: "merged #123", pr: 123, by: "tony" },
    ]);
    expect(out).toContain("Tony: keep field");
    expect(out).toContain("merged #123 (by tony)");
  });

  it("renders the name.N pane suffix, and stays bare when pane absent (acceptance a/c)", () => {
    const out = renderTimeline([
      { ts: 1, iso: "2026-06-22T10:05:00.000Z", oracle: "eq3", pane: "1", kind: "tool", summary: "git status" },
      { ts: 2, iso: "2026-06-22T10:06:00.000Z", oracle: "eq3", pane: "2", kind: "tool", summary: "git log" },
      { ts: 3, iso: "2026-06-22T10:07:00.000Z", oracle: "eq3", kind: "tool", summary: "git diff" }, // old entry, no pane
    ]);
    expect(out).toContain("eq3.1  git status");
    expect(out).toContain("eq3.2  git log");
    expect(out).toContain("eq3  git diff"); // back-compat: no suffix, no stray dot
    expect(out).not.toContain("eq3.  git diff");
  });

  it("handles empty log", () => { expect(renderTimeline([])).toContain("ว่าง"); });

  it("drops 'idle' but KEEPS 'error' in the text render (kobo-109/111 — error is rare + actionable)", () => {
    const out = renderTimeline([
      { ts: 1, iso: "2026-06-22T10:05:00.000Z", oracle: "eq3", pane: "0", kind: "tool", summary: "git status" },
      { ts: 2, iso: "2026-06-22T10:06:00.000Z", oracle: "eq3", paneId: "%40", kind: "idle", summary: "idle" },
      { ts: 3, iso: "2026-06-22T10:07:00.000Z", oracle: "eq3", paneId: "%41", kind: "error", summary: "API error (turn ended)" },
    ]);
    expect(out).toContain("git status");
    expect(out).not.toContain("idle");
    expect(out).toContain("API error (turn ended)"); // error survives the render filter
  });
});

describe("ping", () => {
  it("pingOnMerge hits lead + author", () => {
    const sent: string[] = [];
    const pinged = pingOnMerge({ lead: "pm", author: "worker", pr: 7, repo: "o/r", by: "tony" },
      { send: t => sent.push(t) });
    expect(pinged.sort()).toEqual(["pm", "worker"]);
  });
  it("pingCollision notifies others with the task", () => {
    let msg = "";
    pingCollision("w2", "fix login", ["w1"], { send: (_t, m) => { msg = m; } });
    expect(msg).toContain("fix login");
  });
});

describe("store per-company + claims", () => {
  it("routes by company and reads back with filters", () => {
    appendWorklog({ ts: 1, iso: "i1", oracle: "a", company: "acme", kind: "tool", summary: "git x" });
    appendWorklog({ ts: 2, iso: "i2", oracle: "b", company: "acme", kind: "tool", summary: "git y" });
    appendWorklog({ ts: 3, iso: "i3", oracle: "a", company: "other", kind: "tool", summary: "git z" });

    expect(readWorklog("acme").length).toBe(2);
    expect(readWorklog("other").length).toBe(1);
    expect(readWorklog("acme", { oracle: "a" }).map(e => e.summary)).toEqual(["git x"]);
  });

  it("openClaims excludes released", () => {
    appendWorklog({ ts: 10, iso: "i", oracle: "a", company: "cc", kind: "claim", summary: "claim: T1", task: "T1" });
    appendWorklog({ ts: 11, iso: "i", oracle: "b", company: "cc", kind: "claim", summary: "claim: T2", task: "T2" });
    appendWorklog({ ts: 12, iso: "i", oracle: "a", company: "cc", kind: "claim-release", summary: "release: T1", task: "T1" });
    const open = openClaims("cc");
    expect(open.map(c => c.task)).toEqual(["T2"]);
  });
});

describe("claim logic", () => {
  it("tasksOverlap matches equal / substring", () => {
    expect(tasksOverlap("fix login bug", "fix login bug")).toBe(true);
    expect(tasksOverlap("fix login", "fix login bug")).toBe(true);
    expect(tasksOverlap("fix login", "refactor css")).toBe(false);
  });
  it("collidingClaims finds others' overlapping open claims", () => {
    appendWorklog({ ts: 20, iso: "i", oracle: "w1", company: "col", kind: "claim", summary: "claim: build auth", task: "build auth" });
    const hits = collidingClaims("col", "w2", "build auth flow");
    expect(hits.map(h => h.oracle)).toEqual(["w1"]);
    expect(collidingClaims("col", "w1", "build auth flow")).toEqual([]); // same oracle = no collision
  });
  it("addClaim + releaseClaim write entries", () => {
    const { entry } = addClaim("solo", "unique-task-xyz");
    expect(entry.kind).toBe("claim");
    expect(entry.task).toBe("unique-task-xyz");
    expect(releaseClaim("solo", "unique-task-xyz").kind).toBe("claim-release");
  });
});

describe("inject slice", () => {
  it("includes open claims + recent activity for the oracle's company", () => {
    // company resolves to undefined in test env → _unscoped log
    appendWorklog({ ts: 30, iso: "i", oracle: "zz", kind: "claim", summary: "claim: slice-task", task: "slice-task" });
    appendWorklog({ ts: 31, iso: "i", oracle: "zz", kind: "tool", summary: "git slice-marker" });
    const out = buildInjectSlice("zz");
    expect(out).toContain("slice-task");
    expect(out).toContain("git slice-marker");
    expect(out).toContain("read before acting");
  });

  it("excludes 'idle' from the inject window so real activity isn't starved (kobo-109)", () => {
    // 20 idle events (one per turn-end) would otherwise fill the 12-event window and
    // push the single real event out entirely — the auto-inject must never show idle.
    for (let i = 0; i < 20; i++) {
      appendWorklog({ ts: 100 + i, iso: "i", oracle: "floody", paneId: "%9", kind: "idle", summary: "idle" });
    }
    appendWorklog({ ts: 90, iso: "i", oracle: "floody", pane: "0", kind: "tool", summary: "git real-work-marker" });
    const out = buildInjectSlice("floody");
    expect(out).toContain("git real-work-marker"); // survives despite 20 idles after it
    expect(out).not.toContain("idle");
  });

  it("readWorklog excludeKinds drops before the limit slice", () => {
    for (let i = 0; i < 15; i++) appendWorklog({ ts: 200 + i, iso: "i", oracle: "ek", kind: "idle", summary: "idle" });
    appendWorklog({ ts: 199, iso: "i", oracle: "ek", kind: "tool", summary: "git keep-me" });
    const rows = readWorklog(null, { limit: 5, excludeKinds: ["idle"], oracle: "ek" });
    expect(rows.some(r => r.summary === "git keep-me")).toBe(true);
    expect(rows.every(r => r.kind !== "idle")).toBe(true);
  });

  it("KEEPS 'error' in the inject (only idle is excluded) — rare + actionable (kobo-111)", () => {
    appendWorklog({ ts: 300, iso: "i", oracle: "errq", paneId: "%7", kind: "error", summary: "API error (turn ended)" });
    const out = buildInjectSlice("errq");
    expect(out).toContain("API error (turn ended)"); // error must reach the agent's inject
  });
});

describe("server wiring — feed listener persists tool-calls (as in server.ts)", () => {
  it("a PostToolUse git event via the real feed pipeline lands in the worklog; reads dropped", async () => {
    const { feedListeners, pushFeedEvent } = await import("../../api/feed");
    const { registerWorklogListener } = await import("./listener");
    registerWorklogListener(feedListeners);

    const before = readWorklog(null).length; // _unscoped (no company in test)
    pushFeedEvent(feed({ event: "PostToolUse", ts: 5_000, data: { tool_name: "Bash", tool_input: { command: "git push wire-marker" } } }));
    pushFeedEvent(feed({ event: "PostToolUse", ts: 6_000, data: { tool_name: "Read", tool_input: { file_path: "/x" } } }));
    await flushWorklog(); // listener now writes async (non-blocking hot path)

    const entries = readWorklog(null);
    expect(entries.length - before).toBe(1);
    expect(entries[entries.length - 1].summary).toBe("git push wire-marker");
  });
});

describe("append safety + route", () => {
  it("bounds line size so appends stay atomic (large summary truncated, still valid JSON)", () => {
    const huge = "git " + "x".repeat(10_000);
    appendWorklog({ ts: 99, iso: "i", oracle: "big", company: "bnd", kind: "tool", summary: huge });
    const got = readWorklog("bnd");
    expect(got.length).toBe(1); // line parsed (not corrupt/dropped)
    expect(got[0].summary.length).toBeLessThan(huge.length);
  });

  it("handleWorklogRequest serves inject + entries as JSON", async () => {
    appendWorklog({ ts: 1, iso: "i", oracle: "rr", company: "rc", kind: "tool", summary: "git route-marker" });
    const entriesRes = handleWorklogRequest(new Request("http://x/api/worklog?company=rc&limit=10"));
    expect(await entriesRes.json()).toEqual({ entries: expect.arrayContaining([expect.objectContaining({ summary: "git route-marker" })]) });
    const injectRes = handleWorklogRequest(new Request("http://x/api/worklog?oracle=rr"));
    expect((await injectRes.json())).toHaveProperty("inject");
  });
});

describe("readWorklog incremental cache (kobo-463 — full-file read+parse on every call)", () => {
  const entry = (company: string, n: number) =>
    ({ ts: n, iso: `i${n}`, oracle: "o", company, kind: "tool" as const, summary: `git op-${n}` });

  it("append then re-read: sees the new line without losing the old ones", () => {
    _resetWorklogCache();
    appendWorklog(entry("c463a", 1));
    const first = readWorklog("c463a");
    expect(first.map(e => e.summary)).toEqual(["git op-1"]);

    appendWorklog(entry("c463a", 2));
    const second = readWorklog("c463a");
    expect(second.map(e => e.summary)).toEqual(["git op-1", "git op-2"]); // old line survived the cache, new one was picked up
  });

  it("shrink (truncate/rotate): drops the stale cache and re-reads the whole file", () => {
    _resetWorklogCache();
    appendWorklog(entry("c463b", 1));
    appendWorklog(entry("c463b", 2));
    const before = readWorklog("c463b");
    expect(before.length).toBe(2);

    // simulate rotation: a shorter file with entirely different content at the same path
    writeFileSync(worklogPath("c463b"), JSON.stringify({ ...entry("c463b", 9), summary: "git rotated" }) + "\n");
    const after = readWorklog("c463b");
    expect(after.map(e => e.summary)).toEqual(["git rotated"]); // not a leftover union with the old 2 — a real re-read
  });

  it("no change: does not re-read the file (proven by corrupting it in place at the same byte size)", () => {
    _resetWorklogCache();
    appendWorklog(entry("c463c", 1));
    const first = readWorklog("c463c");
    expect(first.map(e => e.summary)).toEqual(["git op-1"]);

    // overwrite with garbage of the EXACT same byte length: a real re-read would either
    // throw or silently drop the malformed line (empty result) — a skipped read can't
    // observe the corruption at all, so the cached value is the only way to stay correct
    const p = worklogPath("c463c");
    const size = statSync(p).size;
    writeFileSync(p, "x".repeat(size));
    const second = readWorklog("c463c");
    expect(second.map(e => e.summary)).toEqual(["git op-1"]); // unchanged — proves the file was never touched again
  });

  it("switching companies kobo→pgw→kobo: each read is scoped to its own company, and the 3rd read doesn't re-read kobo's file", () => {
    _resetWorklogCache();
    appendWorklog(entry("kobo463", 1));
    appendWorklog(entry("pgw463", 100));

    const kobo1 = readWorklog("kobo463");
    expect(kobo1.map(e => e.summary)).toEqual(["git op-1"]); // not mixed with pgw

    const pgw1 = readWorklog("pgw463");
    expect(pgw1.map(e => e.summary)).toEqual(["git op-100"]); // not mixed with kobo — proves per-path Map, not one shared slot

    // corrupt kobo's file at the same byte size between the 1st and 3rd kobo read —
    // if a single-slot cache got clobbered by reading pgw in between, this 3rd call
    // would either re-read (and see the corruption) or return pgw's data (wrong company)
    const p = worklogPath("kobo463");
    const size = statSync(p).size;
    writeFileSync(p, "y".repeat(size));

    const kobo2 = readWorklog("kobo463");
    expect(kobo2.map(e => e.summary)).toEqual(["git op-1"]); // still kobo's own cached entry, untouched by the pgw read in between
  });

  it("does not return the cache's own array — mutating a caller's result must not leak into the next read (kobo-463 c5)", () => {
    _resetWorklogCache();
    appendWorklog(entry("c463d", 1));
    const first = readWorklog("c463d");
    first.push(entry("c463d", 999)); // simulate a caller mutating its result (sort/push)

    const second = readWorklog("c463d");
    expect(second.map(e => e.summary)).toEqual(["git op-1"]); // not corrupted by the mutation above
  });

  it("read landing mid-append: a half-written trailing line is not dropped, it's picked up whole next read (kobo-463, %11's find)", () => {
    _resetWorklogCache();
    appendWorklog(entry("c463e", 1));
    const first = readWorklog("c463e");
    expect(first.map(e => e.summary)).toEqual(["git op-1"]);

    // simulate a write landing mid-flush: append the line's bytes WITHOUT the
    // trailing newline yet — a read right now would see this as a torn tail
    const p = worklogPath("c463e");
    const full = JSON.stringify(entry("c463e", 2)) + "\n";
    const torn = full.slice(0, full.length - 5); // cut before the closing brace+newline
    appendFileSync(p, torn);

    const mid = readWorklog("c463e");
    expect(mid.map(e => e.summary)).toEqual(["git op-1"]); // torn line not parsed, not dropped either

    // the rest of the line lands
    appendFileSync(p, full.slice(full.length - 5));
    const after = readWorklog("c463e");
    expect(after.map(e => e.summary)).toEqual(["git op-1", "git op-2"]); // now whole, and only once
  });
});

describe("hook scripts stay in sync with embedded base64", () => {
  it("decoded base64 matches scripts/hooks/*.sh", async () => {
    const { hookScriptBody } = await import("./hook-setup");
    const root = join(import.meta.dir, "../../..");
    for (const f of ["worklog-tool.sh", "worklog-convo.sh", "worklog-orient.sh", "company-policy.sh", "toilet-away.sh", "seat-back.sh", "maw-mcp-nudge.sh", "maw-statusline.sh"]) {
      const onDisk = readFileSync(join(root, "scripts/hooks", f), "utf-8");
      expect(hookScriptBody(f)).toBe(onDisk);
    }
  });
});
