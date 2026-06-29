import { describe, expect, test } from "bun:test";
import { handleTasksRequest } from "./route";

describe("handleTasksRequest (company-ui board stub)", () => {
  test("returns the locked contract shape for a company", async () => {
    const res = handleTasksRequest(new Request("http://x/api/tasks?company=pgw"));
    const body = (await res.json()) as { company: string; tasks: unknown[] };
    expect(body.company).toBe("pgw");
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.tasks.length).toBeGreaterThan(0);
    // every card carries the spec §6 fields + a valid state column
    for (const t of body.tasks as Array<Record<string, unknown>>) {
      expect(typeof t.id).toBe("string");
      expect(typeof t.title).toBe("string");
      expect(typeof t.dept).toBe("string");
      expect(["open", "claimed", "done"]).toContain(t.state);
      expect("assignee" in t).toBe(true);
      expect(typeof t.by).toBe("string");
      expect(typeof t.ts).toBe("number");
    }
  });

  test("ids are namespaced by company so kobo + pgw boards never collide", async () => {
    const res = handleTasksRequest(new Request("http://x/api/tasks?company=kobo"));
    const body = (await res.json()) as { tasks: Array<{ id: string }> };
    for (const t of body.tasks) expect(t.id.startsWith("kobo-")).toBe(true);
  });

  test("no company → empty board (no throw)", async () => {
    const res = handleTasksRequest(new Request("http://x/api/tasks"));
    const body = (await res.json()) as { company: null; tasks: unknown[] };
    expect(body.company).toBeNull();
    expect(body.tasks).toEqual([]);
  });
});
