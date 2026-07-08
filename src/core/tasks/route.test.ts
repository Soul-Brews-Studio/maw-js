import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleTaskApproveRequest, handleTaskArchiveRequest, handleTaskCommentRequest, handleTaskCreateRequest, handleTaskDoneRequest, handleTaskEventsRequest, handleTaskNoteRequest, handleTaskResolveRequest, handleTasksRequest } from "./route";
import { addTask, claimTask, commentTask, completeTask, listArchivedTasks, listTasks, noteTask, prOpenedReview, readTask, setTaskPr } from "./store";

const dir = mkdtempSync(join(tmpdir(), "maw-tasks-route-"));
const prev = process.env.MAW_DATA_DIR;
const prevTest = process.env.MAW_TEST_MODE;

beforeAll(() => {
  process.env.MAW_DATA_DIR = dir;
  process.env.MAW_TEST_MODE = "1"; // notifyTaskComment must not fire a real `maw hey` subprocess
  addTask({ company: "pgw", title: "backlog item", by: "eq3", dept: "core" });
  const t = addTask({ company: "pgw", title: "claimed item", by: "eq3", repo: "meganechan/maw-js" });
  claimTask("pgw", t.id, "patchwork");
});
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  if (prevTest === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = prevTest;
  rmSync(dir, { recursive: true, force: true });
});

describe("handleTasksRequest (real file-per-card store)", () => {
  test("returns cards from the store in the contract shape", async () => {
    const body = (await handleTasksRequest(new Request("http://x/api/tasks?company=pgw")).json()) as {
      company: string;
      tasks: Array<Record<string, unknown>>;
    };
    expect(body.company).toBe("pgw");
    expect(body.tasks.length).toBe(2);
    for (const t of body.tasks) {
      expect(typeof t.id).toBe("string");
      expect(typeof t.title).toBe("string");
      expect(["backlog", "todo", "in-progress", "review", "done", "blocked"]).toContain(t.state);
      expect("assignee" in t).toBe(true);
      expect("dept" in t && "epic" in t).toBe(true); // ADR fields present
      expect(typeof t.by).toBe("string");
      expect(typeof t.ts).toBe("number");
      expect(typeof t.nextAction).toBe("string"); // Track 4 — always present
      expect((t.nextAction as string).length).toBeGreaterThan(0);
    }
  });

  test("reflects a claim (assignee + in-progress)", async () => {
    const body = (await handleTasksRequest(new Request("http://x/api/tasks?company=pgw")).json()) as {
      tasks: Array<{ title: string; state: string; assignee: string | null }>;
    };
    const claimed = body.tasks.find((t) => t.title === "claimed item");
    expect(claimed?.state).toBe("in-progress");
    expect(claimed?.assignee).toBe("patchwork");
  });

  test("PR-open lifecycle shows on /api/tasks — UI ↔ store match (eq3-011 kobo-13)", async () => {
    process.env.MAW_DATA_DIR = dir;
    const t = addTask({ company: "prw", title: "ship feature", by: "eq3", assignee: "patchwork" }); // doer = patchwork
    setTaskPr("prw", t.id, 88, "patchwork"); // worker attaches the PR (card.pr link)
    prOpenedReview("prw", t.id, "meganechan"); // pr-watch drives it on OPEN — PR author is the shared account
    const body = (await handleTasksRequest(new Request("http://x/api/tasks?company=prw")).json()) as {
      tasks: Array<{ title: string; state: string; assignee: string | null; reviewer?: string; pr?: number; nextAction: string }>;
    };
    const card = body.tasks.find((c) => c.title === "ship feature")!;
    expect(card.state).toBe("review"); // board no longer says "todo รอคนหยิบ"
    expect(card.assignee).toBe("patchwork"); // kobo-217: doer kept — NOT the shared-github PR author
    expect(card.reviewer).toBe("eq3"); // kobo-144 addendum: creator reviews their PR (not hardcoded human)
    expect(card.pr).toBe(88);
    expect(card.nextAction).toContain("PR #88"); // "รอ merge PR #88 → done"
  });

  test("derives checklist N/M from body; absent when no checkbox (ADR 0003 C)", async () => {
    process.env.MAW_DATA_DIR = dir;
    addTask({ company: "kobo", title: "with checklist", by: "eq3", body: "plan\n- [ ] a\n- [x] b\n- [x] c" });
    addTask({ company: "kobo", title: "plain", by: "eq3", body: "just a note, no boxes" });
    const body = (await handleTasksRequest(new Request("http://x/api/tasks?company=kobo")).json()) as {
      tasks: Array<{ title: string; checklist?: { done: number; total: number } }>;
    };
    const withList = body.tasks.find((t) => t.title === "with checklist");
    const plain = body.tasks.find((t) => t.title === "plain");
    expect(withList?.checklist).toEqual({ done: 2, total: 3 });
    expect("checklist" in (plain as object)).toBe(false); // no badge on a plain card
  });

  test("passes body through for the detail view; absent when no body (eq3-010 kobo-11)", async () => {
    process.env.MAW_DATA_DIR = dir;
    addTask({ company: "det", title: "has body", by: "eq3", body: "# why\n- [ ] step a" });
    addTask({ company: "det", title: "no body", by: "eq3" });
    const body = (await handleTasksRequest(new Request("http://x/api/tasks?company=det")).json()) as {
      tasks: Array<{ title: string; body?: string }>;
    };
    expect(body.tasks.find((t) => t.title === "has body")?.body).toBe("# why\n- [ ] step a"); // raw markdown passthrough
    expect("body" in (body.tasks.find((t) => t.title === "no body") as object)).toBe(false); // absent when none
  });

  test("derives dependency block from parents (ADR 0003 A on web); reuses the store helper", async () => {
    process.env.MAW_DATA_DIR = dir;
    const parent = addTask({ company: "dep", title: "parent", by: "eq3" }); // dep-1, todo
    addTask({ company: "dep", title: "child", by: "eq3", parentIds: [parent.id, "ghost-9"] }); // dep-2
    addTask({ company: "dep", title: "free", by: "eq3" }); // dep-3, no parents
    const read = async () => (await handleTasksRequest(new Request("http://x/api/tasks?company=dep")).json()) as {
      tasks: Array<{ title: string; state: string; dependency?: { blockedBy: string[]; missing: string[] } }>;
    };
    let tasks = (await read()).tasks;
    const child = tasks.find((t) => t.title === "child");
    const free = tasks.find((t) => t.title === "free");
    expect(child?.dependency).toEqual({ blockedBy: ["dep-1"], missing: ["ghost-9"] }); // parent pending + ghost missing
    expect(child?.state).toBe("blocked"); // kobo-223: dependency block is now a REAL state (was derived-todo)
    expect("dependency" in (free as object)).toBe(false); // no parents → no field
    // parent done → child auto-returns (blockedBy drops; state restored todo → ready)
    completeTask("dep", parent.id, "eq3");
    tasks = (await read()).tasks;
    const backChild = tasks.find((t) => t.title === "child");
    expect(backChild?.dependency).toEqual({ blockedBy: [], missing: ["ghost-9"] });
    expect(backChild?.state).toBe("ready"); // restored + kobo-133 promote (deps ครบ)
  });

  test("derives needsOwner for todo+unassigned; absent once owned or non-todo (eq3-011 kobo-14)", async () => {
    process.env.MAW_DATA_DIR = dir;
    addTask({ company: "own", title: "orphan", by: "eq3" }); // todo, unassigned → needs owner
    addTask({ company: "own", title: "owned", by: "eq3", assignee: "patchwork" }); // todo, assigned
    const read = async () => (await handleTasksRequest(new Request("http://x/api/tasks?company=own")).json()) as {
      tasks: Array<{ title: string; needsOwner?: true }>;
    };
    let tasks = (await read()).tasks;
    expect(tasks.find((t) => t.title === "orphan")?.needsOwner).toBe(true);
    expect("needsOwner" in (tasks.find((t) => t.title === "owned") as object)).toBe(false); // has owner
    // assign the orphan → needsOwner drops on the next read (derived, auto-return)
    claimTask("own", "own-1", "patchwork");
    tasks = (await read()).tasks;
    expect("needsOwner" in (tasks.find((t) => t.title === "orphan") as object)).toBe(false);
  });

  test("unknown company → empty (no throw)", async () => {
    const body = (await handleTasksRequest(new Request("http://x/api/tasks?company=nope")).json()) as {
      tasks: unknown[];
    };
    expect(body.tasks).toEqual([]);
  });

  test("no company → empty board", async () => {
    const body = (await handleTasksRequest(new Request("http://x/api/tasks")).json()) as {
      company: null;
      tasks: unknown[];
    };
    expect(body.company).toBeNull();
    expect(body.tasks).toEqual([]);
  });
});

describe("handleTaskArchiveRequest (POST /api/tasks/archive — kobo-35)", () => {
  const post = (payload: unknown) =>
    handleTaskArchiveRequest(new Request("http://x/api/tasks/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }));

  test("archives one done card → gone from /api/tasks AND the store (board-truth both sides)", async () => {
    const t = addTask({ company: "arc", title: "reviewed card", by: "tony" });
    completeTask("arc", t.id, "tony");
    // present on the board before archive
    const before = (await handleTasksRequest(new Request("http://x/api/tasks?company=arc")).json()) as { tasks: Array<{ id: string }> };
    expect(before.tasks.map((c) => c.id)).toContain(t.id);

    const res = await post({ company: "arc", id: t.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: t.id, title: "reviewed card" });

    // UI side: no longer returned by /api/tasks
    const after = (await handleTasksRequest(new Request("http://x/api/tasks?company=arc")).json()) as { tasks: Array<{ id: string }> };
    expect(after.tasks.map((c) => c.id)).not.toContain(t.id);
    // store side: moved out of active tasks, preserved in archive/ (principle 1)
    expect(listTasks("arc").map((c) => c.id)).not.toContain(t.id);
    expect(listArchivedTasks("arc").map((c) => c.id)).toContain(t.id);
  });

  test("missing id → 404, missing fields → 400, bad JSON → 400", async () => {
    expect((await post({ company: "arc", id: "arc-999" })).status).toBe(404);
    expect((await post({ company: "arc" })).status).toBe(400);
    const bad = await handleTaskArchiveRequest(new Request("http://x/api/tasks/archive", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" }));
    expect(bad.status).toBe(400);
  });
});

describe("handleTaskNoteRequest (POST /api/tasks/note — kobo-46)", () => {
  const post = (body: unknown) =>
    handleTaskNoteRequest(new Request("http://x/api/tasks/note", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));

  test("appends a note by=tony + returns the updated notes", async () => {
    const t = addTask({ company: "note", title: "web comment target", by: "eq3", assignee: "patchwork" });
    const res = await post({ company: "note", id: t.id, text: "please rebase onto alpha" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; id: string; notes: Array<{ by: string; text: string }> };
    expect(json.ok).toBe(true);
    expect(json.notes).toHaveLength(1);
    expect(json.notes[0]).toMatchObject({ by: "tony", text: "please rebase onto alpha" });
    // durably stored (append-only) — the very next read sees it
    expect(readTask("note", t.id)!.notes?.[0]?.by).toBe("tony");
  });

  test("missing fields → 400, unknown id → 404, bad JSON → 400", async () => {
    expect((await post({ company: "note", id: "note-1" })).status).toBe(400); // no text
    expect((await post({ company: "note", id: "note-999", text: "hi" })).status).toBe(404);
    const bad = await handleTaskNoteRequest(new Request("http://x/api/tasks/note", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" }));
    expect(bad.status).toBe(400);
  });

  test("epic card projection carries derived familyNotes (descendant notes, tagged)", async () => {
    const epic = addTask({ company: "fam", title: "epic", by: "eq3", kind: "epic" });
    const child = addTask({ company: "fam", title: "child", by: "eq3", epic: epic.id });
    noteTask("fam", child.id, "patchwork", "child progress");
    const body = (await handleTasksRequest(new Request("http://x/api/tasks?company=fam")).json()) as {
      tasks: Array<{ id: string; kind?: string; familyNotes?: Array<{ from: string; text: string }> }>;
    };
    const epicCard = body.tasks.find((c) => c.id === epic.id)!;
    expect(epicCard.kind).toBe("epic");
    expect(epicCard.familyNotes).toEqual([{ from: child.id, text: "child progress", by: "patchwork", ts: expect.any(Number), iso: expect.any(String) }]);
    // a plain task carries no familyNotes
    expect(body.tasks.find((c) => c.id === child.id)!.familyNotes).toBeUndefined();
  });
});

describe("handleTaskCommentRequest / handleTaskResolveRequest (POST /api/tasks/comment + /resolve — kobo-141)", () => {
  const comment = (body: unknown) =>
    handleTaskCommentRequest(new Request("http://x/api/tasks/comment", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
  const resolve = (body: unknown) =>
    handleTaskResolveRequest(new Request("http://x/api/tasks/resolve", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));

  test("adds a threaded comment by=tony (+ reply) and resolve flips the flag", async () => {
    const t = addTask({ company: "cmt", title: "ask target", by: "eq3", assignee: "patchwork" });
    const c1 = await comment({ company: "cmt", id: t.id, text: "@tony ship?" });
    expect(c1.status).toBe(200);
    const j1 = (await c1.json()) as { ok: boolean; comments: Array<{ id: string; by: string; text: string; replyTo?: string }> };
    expect(j1.ok).toBe(true);
    expect(j1.comments).toHaveLength(1);
    expect(j1.comments[0]).toMatchObject({ id: "c1", by: "tony", text: "@tony ship?" });
    // reply threads under c1
    const c2 = await comment({ company: "cmt", id: t.id, text: "yes", replyTo: "c1" });
    const j2 = (await c2.json()) as { comments: Array<{ id: string; replyTo?: string }> };
    expect(j2.comments[1]).toMatchObject({ id: "c2", replyTo: "c1" });
    // resolve c1 → resolved flag set, text preserved (Principle 1)
    const r = await resolve({ company: "cmt", id: t.id, commentId: "c1" });
    expect(r.status).toBe(200);
    const jr = (await r.json()) as { comments: Array<{ id: string; resolved?: boolean; resolvedBy?: string; text: string }> };
    expect(jr.comments[0]).toMatchObject({ id: "c1", resolved: true, resolvedBy: "tony", text: "@tony ship?" });
  });

  test("comment GET-projection exposes comments[]; bad replyTo → 400; unknown id/comment → 404; missing fields/bad JSON → 400", async () => {
    const t = addTask({ company: "cmt2", title: "proj", by: "eq3", assignee: "patchwork" });
    commentTask("cmt2", t.id, "eq3", "hi");
    const board = (await handleTasksRequest(new Request("http://x/api/tasks?company=cmt2")).json()) as {
      tasks: Array<{ id: string; comments?: Array<{ id: string; text: string }> }>;
    };
    expect(board.tasks.find((c) => c.id === t.id)!.comments).toEqual([expect.objectContaining({ id: "c1", text: "hi" })]);
    // replyTo names a comment not on this card → 400 (no dangling threads)
    expect((await comment({ company: "cmt2", id: t.id, text: "x", replyTo: "c99" })).status).toBe(400);
    expect((await comment({ company: "cmt2", id: t.id })).status).toBe(400); // no text
    expect((await comment({ company: "cmt2", id: "cmt2-999", text: "x" })).status).toBe(404);
    expect((await resolve({ company: "cmt2", id: t.id, commentId: "c99" })).status).toBe(404); // no such comment
    expect((await resolve({ company: "cmt2", id: t.id })).status).toBe(400); // no commentId
    const bad = await handleTaskCommentRequest(new Request("http://x/api/tasks/comment", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" }));
    expect(bad.status).toBe(400);
  });
});

describe("handleTaskCreateRequest (POST /api/tasks/create — kobo-48)", () => {
  const post = (body: unknown) =>
    handleTaskCreateRequest(new Request("http://x/api/tasks/create", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));

  test("creates a subtask (epic = parent) by=tony → appears on the board under the epic", async () => {
    const epic = addTask({ company: "cr", title: "epic root", by: "eq3", kind: "epic" });
    const res = await post({ company: "cr", title: "web subtask", epic: epic.id });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; task: { id: string; epic: string | null; state: string } };
    expect(json.ok).toBe(true);
    expect(json.task.epic).toBe(epic.id);
    // stored with the containment parent + default todo state + by=tony
    const stored = readTask("cr", json.task.id)!;
    expect(stored.epic).toBe(epic.id);
    expect(stored.by).toBe("tony");
    expect(stored.state).toBe("todo");
    // shows on the board as a child of the epic
    const board = (await handleTasksRequest(new Request("http://x/api/tasks?company=cr")).json()) as { tasks: Array<{ id: string; epic: string | null }> };
    expect(board.tasks.find((c) => c.id === json.task.id)!.epic).toBe(epic.id);
  });

  test("plain create (no epic) works; missing title/company → 400; bad JSON → 400", async () => {
    const res = await post({ company: "cr", title: "standalone" });
    expect(res.status).toBe(200);
    expect((await (await post({ company: "cr" })).json() as { ok: boolean }).ok).toBe(false); // no title
    expect((await post({ company: "cr" })).status).toBe(400);
    expect((await post({ title: "orphan" })).status).toBe(400); // no company
    const bad = await handleTaskCreateRequest(new Request("http://x/api/tasks/create", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" }));
    expect(bad.status).toBe(400);
  });

  test("validation (trust boundary): whitespace-only title → 400, over-long title → 400", async () => {
    expect((await post({ company: "cr", title: "   " })).status).toBe(400); // trims to empty
    expect((await post({ company: "cr", title: "x".repeat(501) })).status).toBe(400); // over MAX_TITLE_LEN
    expect((await post({ company: "cr", title: "x".repeat(500) })).status).toBe(200); // exactly at the cap is fine
  });

  test("unresolvable epic id is allowed (plain tag — c1 backward-compat), not a reject", async () => {
    const res = await post({ company: "cr2", title: "orphan child", epic: "cr2-ghost" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; task: { epic: string | null } };
    expect(json.ok).toBe(true);
    expect(json.task.epic).toBe("cr2-ghost"); // kept as a tag, resolves to nothing on the board
  });

  test("cyclic epic (epic = the card's own freshly-allocated id) → 409, reusing c1's loop guard", async () => {
    // A fresh company allocates <c>-1 first; passing epic = that same id makes the
    // new card its own parent → setTaskEpic (c1) rejects the self-loop.
    const res = await post({ company: "cyc", title: "would self-loop", epic: "cyc-1" });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/loop/i);
    // the card was created but left unparented (never self-referential)
    expect(readTask("cyc", "cyc-1")!.epic).toBeUndefined();
  });
});

describe("handleTaskArchiveRequest guard a (kobo-48 — epic with open children → 409)", () => {
  test("archiving an epic that still has open children → 409 + blockedBy list (not a 500)", async () => {
    const epic = addTask({ company: "guard", title: "epic", by: "eq3", kind: "epic" });
    const a = addTask({ company: "guard", title: "open child", by: "eq3", epic: epic.id });
    completeTask("guard", epic.id, "tony"); // epic done, but child a still open
    const res = await handleTaskArchiveRequest(new Request("http://x/api/tasks/archive", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ company: "guard", id: epic.id }),
    }));
    expect(res.status).toBe(409);
    const json = (await res.json()) as { ok: boolean; blockedBy: string[] };
    expect(json.ok).toBe(false);
    expect(json.blockedBy).toEqual([a.id]);
    // epic NOT archived — still on the board
    expect(listTasks("guard").map((c) => c.id)).toContain(epic.id);
  });
});

describe("handleTaskDoneRequest (POST /api/tasks/done — kobo-50 guard b web trigger)", () => {
  const post = (body: unknown) =>
    handleTaskDoneRequest(new Request("http://x/api/tasks/done", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));

  test("a plain card marks done → 200, state=done", async () => {
    const t = addTask({ company: "dn", title: "leaf", by: "eq3", assignee: "patchwork" });
    const res = await post({ company: "dn", id: t.id });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { task: { state: string } }).task.state).toBe("done");
    expect(readTask("dn", t.id)!.state).toBe("done");
  });

  test("epic with open children + no confirm → 409 needsConfirm + rollup N/M + openChildren (guard b)", async () => {
    const epic = addTask({ company: "dn", title: "epic", by: "eq3", kind: "epic" });
    const a = addTask({ company: "dn", title: "child a", by: "eq3", epic: epic.id });
    addTask({ company: "dn", title: "child b", by: "eq3", epic: epic.id });
    completeTask("dn", a.id, "eq3"); // 1 of 2 children done
    const res = await post({ company: "dn", id: epic.id });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { ok: boolean; needsConfirm: boolean; rollup: { done: number; total: number }; openChildren: string[] };
    expect(json.needsConfirm).toBe(true);
    expect(json.rollup.done).toBe(1);
    expect(json.rollup.total).toBe(2);
    expect(json.openChildren).toHaveLength(1);
    expect(readTask("dn", epic.id)!.state).not.toBe("done"); // NOT closed without confirm
  });

  test("epic with open children + confirm:true → 200 (scope collapse allowed)", async () => {
    const epic = addTask({ company: "dn2", title: "epic", by: "eq3", kind: "epic" });
    addTask({ company: "dn2", title: "still open", by: "eq3", epic: epic.id });
    const res = await post({ company: "dn2", id: epic.id, confirm: true });
    expect(res.status).toBe(200);
    expect(readTask("dn2", epic.id)!.state).toBe("done");
  });

  test("missing fields → 400, unknown id → 404, bad JSON → 400", async () => {
    expect((await post({ company: "dn" })).status).toBe(400);
    expect((await post({ company: "dn", id: "dn-999" })).status).toBe(404);
    const bad = await handleTaskDoneRequest(new Request("http://x/api/tasks/done", { method: "POST", headers: { "content-type": "application/json" }, body: "nope" }));
    expect(bad.status).toBe(400);
  });
});

describe("handleTaskApproveRequest (kobo-192 execution-card)", () => {
  const approve = (company: string, id: string) =>
    handleTaskApproveRequest(new Request("http://x/api/tasks/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company, id }),
    }));

  test("no-pr approve → spawns an execution-card (epic=work, assignee=doer, in-progress)", async () => {
    const work = addTask({ company: "pgw", title: "ship the thing", by: "eq3", assignee: "patchwork", state: "approve" });
    const res = await approve("pgw", work.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; task: { id: string; title: string; state: string; assignee: string | null; epic: string | null } };
    expect(body.mode).toBe("spawn");
    expect(body.task.title).toBe("deploy ship the thing");
    expect(body.task.state).toBe("in-progress"); // active work, NOT blocked/off-flow
    expect(body.task.assignee).toBe("patchwork"); // the doer
    expect(body.task.epic).toBe(work.id); // containment link (NOT parentIds → no dep block)
    const exec = readTask("pgw", body.task.id);
    expect(exec?.epic).toBe(work.id);
    expect(exec?.parentIds ?? []).toEqual([]); // never a dependency — would strand it in Blocked
    // mark path NOT taken → no "Tony approved" comment on the work-card
    expect((readTask("pgw", work.id)?.comments ?? []).length).toBe(0);
  });

  test("has-pr approve → mark-only comment, NO execution-card spawned", async () => {
    const work = addTask({ company: "pgw", title: "merge me", by: "eq3", assignee: "patchwork" });
    setTaskPr("pgw", work.id, 4242, "eq3", "meganechan/maw-js"); // pr set (state → review); branch is pr-driven
    const before = listTasks("pgw").length;
    const res = await approve("pgw", work.id);
    const body = (await res.json()) as { mode: string };
    expect(body.mode).toBe("mark");
    const comments = readTask("pgw", work.id)?.comments ?? [];
    expect(comments.some((c) => c.text === "✅ Tony approved")).toBe(true);
    expect(listTasks("pgw").length).toBe(before); // no new card spawned
  });

  test("relate-back is NOTIFY-ONLY: completing the execution-card does NOT auto-flip the work-card (scar kobo-135)", async () => {
    const work = addTask({ company: "pgw", title: "deploy target", by: "eq3", assignee: "patchwork", state: "approve" });
    const body = (await (await approve("pgw", work.id)).json()) as { task: { id: string } };
    completeTask("pgw", body.task.id, "patchwork"); // the doer finishes the deploy
    expect(readTask("pgw", body.task.id)?.state).toBe("done");
    // the work-card must NOT auto-close — Tony/doer closes it manually (auto-flip lies)
    expect(readTask("pgw", work.id)?.state).toBe("approve");
  });

  test("validation: missing id → 400; unknown id → 404; bad JSON → 400", async () => {
    expect((await approve("pgw", "")).status).toBe(400);
    expect((await approve("pgw", "pgw-99999")).status).toBe(404);
    const bad = await handleTaskApproveRequest(new Request("http://x/api/tasks/approve", { method: "POST", headers: { "content-type": "application/json" }, body: "nope" }));
    expect(bad.status).toBe(400);
  });
});

describe("handleTaskEventsRequest (GET /api/tasks/events — SSE, kobo-207)", () => {
  test("missing company/card → 400", () => {
    expect(handleTaskEventsRequest(new Request("http://x/api/tasks/events")).status).toBe(400);
    expect(handleTaskEventsRequest(new Request("http://x/api/tasks/events?company=pgw")).status).toBe(400);
  });

  test("streams SSE headers + pushes a change event when the card gets a note", async () => {
    process.env.MAW_TASK_EVENTS_POLL_MS = "15"; // poll fast so the test doesn't wait 2s
    const t = addTask({ company: "sse", title: "live card", by: "eq3", assignee: "patchwork" });
    const res = handleTaskEventsRequest(new Request(`http://x/api/tasks/events?company=sse&card=${t.id}`));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    // read until we see a `change` event or time out — the note below is the trigger
    let seen = "";
    const deadline = Date.now() + 2000;
    noteTask("sse", t.id, "eq3", "a peer's note lands"); // mutate the store → snapshot diff → change
    while (!seen.includes("event: change") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += dec.decode(value, { stream: true });
    }
    await reader.cancel(); // closes the stream → clearInterval in cancel()
    expect(seen).toContain(": connected"); // initial comment line
    expect(seen).toContain("event: change"); // the note produced a push
    delete process.env.MAW_TASK_EVENTS_POLL_MS;
  });
});
