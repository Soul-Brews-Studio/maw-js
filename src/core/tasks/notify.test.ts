import { describe, expect, test } from "bun:test";
import { notifyParentOfSubcardDone, notifyTaskComment } from "./notify";
import type { TaskRecord } from "./store";

const mk = (over: Partial<TaskRecord>): TaskRecord =>
  ({ id: "kobo-1", title: "t", company: "kobo", state: "in-progress", by: "eq3", assignee: "patchwork", ts: 1, ...over });

describe("notifyTaskComment (kobo-46 — comment = poke)", () => {
  test("non-author comment pokes the assignee on the task-events channel", () => {
    const calls: string[][] = [];
    const sent = notifyTaskComment(mk({ assignee: "patchwork" }), "tony", "please rebase", (a) => calls.push(a));
    expect(sent).toBe(true);
    expect(calls).toHaveLength(1);
    const argv = calls[0];
    // routes on task-events (→ coord pane via registry), NOT a direct pane target
    expect(argv).toEqual(["--channel", "task-events", "patchwork", expect.stringContaining("[task] tony commented on kobo-1")]);
  });

  test("self-comment (author IS the assignee) does not poke", () => {
    const calls: string[][] = [];
    const sent = notifyTaskComment(mk({ assignee: "patchwork" }), "patchwork", "note to self", (a) => calls.push(a));
    expect(sent).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("an unowned card (no assignee) does not poke", () => {
    const calls: string[][] = [];
    const sent = notifyTaskComment(mk({ assignee: null }), "tony", "anyone?", (a) => calls.push(a));
    expect(sent).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("long comment is previewed (≤80 chars) in the poke", () => {
    const calls: string[][] = [];
    const long = "x".repeat(200);
    notifyTaskComment(mk({}), "tony", long, (a) => calls.push(a));
    const msg = calls[0][3];
    expect(msg.length).toBeLessThan(120); // prefix + 77-char preview + …
    expect(msg).toContain("…");
  });

  test("a spawn failure is swallowed (best-effort) → returns false", () => {
    const sent = notifyTaskComment(mk({}), "tony", "boom", () => { throw new Error("spawn failed"); });
    expect(sent).toBe(false);
  });
});

describe("notifyParentOfSubcardDone (kobo-135 B3 — answered subcard pokes the asker)", () => {
  const child = (over: Partial<TaskRecord> = {}): TaskRecord =>
    mk({ id: "kobo-9", title: "answer this?", epic: "kobo-1", assignee: "tony", ...over });
  const parent = (over: Partial<TaskRecord> = {}): TaskRecord =>
    mk({ id: "kobo-1", title: "big work", assignee: "patchwork", ...over });

  test("routed subcard done → pokes the parent's owner on task-events", () => {
    const calls: string[][] = [];
    const sent = notifyParentOfSubcardDone(child(), parent(), "tony", (a) => calls.push(a));
    expect(sent).toBe(true);
    expect(calls[0]).toEqual(["--channel", "task-events", "patchwork", expect.stringContaining("subcard kobo-9 done → kobo-1")]);
  });

  test("unassigned +subtask (not an ask) does not poke", () => {
    const calls: string[][] = [];
    const sent = notifyParentOfSubcardDone(child({ assignee: null }), parent(), "eq3", (a) => calls.push(a));
    expect(sent).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("parent with no owner → nobody to notify", () => {
    const sent = notifyParentOfSubcardDone(child(), parent({ assignee: null }), "tony", () => {});
    expect(sent).toBe(false);
  });

  test("asker closing their own subcard is not self-poked (by === parent owner)", () => {
    const calls: string[][] = [];
    const sent = notifyParentOfSubcardDone(child(), parent({ assignee: "patchwork" }), "patchwork", (a) => calls.push(a));
    expect(sent).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("a spawn failure is swallowed (best-effort) → returns false", () => {
    const sent = notifyParentOfSubcardDone(child(), parent(), "tony", () => { throw new Error("spawn failed"); });
    expect(sent).toBe(false);
  });
});
