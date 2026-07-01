import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleTasksRequest } from "./route";
import { addTask, claimTask, completeTask, prOpenedReview, setTaskPr } from "./store";

const dir = mkdtempSync(join(tmpdir(), "maw-tasks-route-"));
const prev = process.env.MAW_DATA_DIR;

beforeAll(() => {
  process.env.MAW_DATA_DIR = dir;
  addTask({ company: "pgw", title: "backlog item", by: "eq3", dept: "core" });
  const t = addTask({ company: "pgw", title: "claimed item", by: "eq3", repo: "meganechan/maw-js" });
  claimTask("pgw", t.id, "patchwork");
});
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
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
    const t = addTask({ company: "prw", title: "ship feature", by: "eq3" }); // todo, unassigned
    setTaskPr("prw", t.id, 88, "patchwork"); // worker attaches the PR (card.pr link)
    prOpenedReview("prw", t.id, "patchwork"); // pr-watch drives it on OPEN
    const body = (await handleTasksRequest(new Request("http://x/api/tasks?company=prw")).json()) as {
      tasks: Array<{ title: string; state: string; assignee: string | null; reviewer?: string; pr?: number; nextAction: string }>;
    };
    const card = body.tasks.find((c) => c.title === "ship feature")!;
    expect(card.state).toBe("review"); // board no longer says "todo รอคนหยิบ"
    expect(card.assignee).toBe("patchwork"); // owner = PR author
    expect(card.reviewer).toBe("human"); // waiting on the human
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
    expect(child?.state).toBe("todo"); // derived ≠ a block state — real state untouched
    expect("dependency" in (free as object)).toBe(false); // no parents → no field
    // parent done → child auto-returns (field drops to missing-only, no blockedBy)
    completeTask("dep", parent.id, "eq3");
    tasks = (await read()).tasks;
    expect(tasks.find((t) => t.title === "child")?.dependency).toEqual({ blockedBy: [], missing: ["ghost-9"] });
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
