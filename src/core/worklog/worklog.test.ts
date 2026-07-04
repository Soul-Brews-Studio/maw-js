import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { toolSummary, eventToWorklog } from "./significant";
import { renderTimeline } from "./render";
import { pingOnMerge, pingCollision } from "./ping";
import { appendWorklog, readWorklog, openClaims, flushWorklog } from "./store";
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

describe("hook scripts stay in sync with embedded base64", () => {
  it("decoded base64 matches scripts/hooks/*.sh", async () => {
    const { hookScriptBody } = await import("./hook-setup");
    const root = join(import.meta.dir, "../../..");
    for (const f of ["worklog-tool.sh", "worklog-convo.sh", "worklog-orient.sh", "company-policy.sh", "maw-statusline.sh"]) {
      const onDisk = readFileSync(join(root, "scripts/hooks", f), "utf-8");
      expect(hookScriptBody(f)).toBe(onDisk);
    }
  });
});
