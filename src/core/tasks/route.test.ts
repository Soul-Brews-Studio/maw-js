import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleTasksRequest } from "./route";
import { addTask, claimTask } from "./store";

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
      expect(["backlog", "todo", "in-progress", "review", "done", "needs-attention"]).toContain(t.state);
      expect("assignee" in t).toBe(true);
      expect("dept" in t && "epic" in t).toBe(true); // ADR fields present
      expect(typeof t.by).toBe("string");
      expect(typeof t.ts).toBe("number");
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
