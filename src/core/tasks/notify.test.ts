import { describe, expect, test } from "bun:test";
import { notifyCommentReply, notifyParentOfSubcardDone, notifyReviewer, notifyTaskComment } from "./notify";
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

  test("an unassigned card falls to the review chain (creator) instead of going silent (kobo-156)", () => {
    const calls: string[][] = [];
    // no assignee, by="eq3" → resolveReviewer → creator "eq3"; commenter "tony" ≠ target
    const sent = notifyTaskComment(mk({ assignee: null, by: "eq3" }), "tony", "anyone?", (a) => calls.push(a));
    expect(sent).toBe(true);
    expect(calls[0]).toEqual(["--channel", "task-events", "eq3", expect.stringContaining("[task] tony commented on kobo-1")]);
  });

  test("unassigned card commented by the creator → no self-poke (kobo-156)", () => {
    const calls: string[][] = [];
    const sent = notifyTaskComment(mk({ assignee: null, by: "eq3" }), "eq3", "mine", (a) => calls.push(a));
    expect(sent).toBe(false); // resolveReviewer → "eq3" === commenter → skip
    expect(calls).toHaveLength(0);
  });

  test("a comment on a DONE card still pokes the assignee (regression-safe, kobo-156)", () => {
    const calls: string[][] = [];
    const sent = notifyTaskComment(mk({ assignee: "patchwork", state: "done" }), "tony", "one more thing", (a) => calls.push(a));
    expect(sent).toBe(true);
    expect(calls[0][2]).toBe("patchwork");
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

describe("notifyCommentReply (kobo-156 — a reply pokes the parent comment's author)", () => {
  const withComments = (over: Partial<TaskRecord> = {}): TaskRecord =>
    mk({ comments: [{ id: "c1", ts: 1, iso: "", by: "userA", text: "the question" }], ...over });

  test("reply to userA's comment by userB → pokes userA on task-events", () => {
    const calls: string[][] = [];
    const r = notifyCommentReply(withComments(), "c1", "userB", (a) => calls.push(a));
    expect(r).toBe("userA");
    expect(calls[0]).toEqual(["--channel", "task-events", "userA", expect.stringContaining("[task] userB replied to your comment on kobo-1")]);
  });

  test("reply to your own comment → no self-poke", () => {
    const calls: string[][] = [];
    const r = notifyCommentReply(withComments(), "c1", "userA", (a) => calls.push(a));
    expect(r).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("replyTo names no comment on the card → skipped, not crashed", () => {
    const calls: string[][] = [];
    const r = notifyCommentReply(withComments(), "c99", "userB", (a) => calls.push(a));
    expect(r).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("a spawn failure is swallowed (best-effort) → returns null", () => {
    const r = notifyCommentReply(withComments(), "c1", "userB", () => { throw new Error("boom"); });
    expect(r).toBeNull();
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

describe("notifyReviewer (kobo-144 — review lane pokes the resolved reviewer)", () => {
  test("explicit reviewer field is pinged on task-events", () => {
    const calls: string[][] = [];
    const r = notifyReviewer(mk({ state: "review", reviewer: "somsri" }), "patchwork", (a) => calls.push(a));
    expect(r).toBe("somsri");
    expect(calls[0]).toEqual(["--channel", "task-events", "somsri", expect.stringContaining("[task] review kobo-1")]);
  });

  test("no reviewer field → falls to the creator (by), who reviews the doer's work", () => {
    const calls: string[][] = [];
    const r = notifyReviewer(mk({ state: "review", by: "eq3", assignee: "patchwork" }), "patchwork", (a) => calls.push(a));
    expect(r).toBe("eq3"); // creator ≠ doer → creator reviews
    expect(calls).toHaveLength(1);
  });

  test("creator IS the actor being pinged is skipped (no self-poke)", () => {
    const calls: string[][] = [];
    // resolved reviewer = creator "eq3"; the actor pulling review is also eq3 → skip
    const r = notifyReviewer(mk({ state: "review", by: "eq3", assignee: "patchwork" }), "eq3", (a) => calls.push(a));
    expect(r).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("creator is the doer → resolves to human (self-review banned)", () => {
    const calls: string[][] = [];
    const r = notifyReviewer(mk({ state: "review", by: "patchwork", assignee: "patchwork" }), "patchwork", (a) => calls.push(a));
    expect(r).toBe("human"); // by === assignee → fall through to human, pinged (actor is patchwork, not human)
    expect(calls[0][2]).toBe("human");
  });

  test("a spawn failure is swallowed (best-effort) → returns null", () => {
    const r = notifyReviewer(mk({ state: "review", reviewer: "somsri" }), "patchwork", () => { throw new Error("boom"); });
    expect(r).toBeNull();
  });
});
