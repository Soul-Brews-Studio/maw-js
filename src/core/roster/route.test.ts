import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleRosterRequest } from "./route";
import { addTask, claimTask } from "../tasks/store";

const dir = mkdtempSync(join(tmpdir(), "maw-roster-route-"));
const prev = process.env.MAW_DATA_DIR;

beforeAll(() => {
  process.env.MAW_DATA_DIR = dir;
  const t = addTask({ company: "kobo", title: "wire route", by: "eq3" });
  claimTask("kobo", t.id, "patchwork"); // → in-progress, held by patchwork
});
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("handleRosterRequest — kobo-445 review round 2: pending is opt-in", () => {
  test("no ?pending=1 → held is still populated, pending is an empty object (existing callers unaffected)", async () => {
    const res = handleRosterRequest(new Request("http://x/api/roster?company=kobo"));
    const body = (await res.json()) as { held: Record<string, unknown[]>; pending: Record<string, unknown[]> };
    expect(body.held.patchwork).toBeDefined(); // existing behavior untouched
    expect(body.pending).toEqual({}); // NOT computed/shipped unless asked
  });

  test("?pending=1 → pending is populated with the real held card", async () => {
    const res = handleRosterRequest(new Request("http://x/api/roster?company=kobo&pending=1"));
    const body = (await res.json()) as { pending: Record<string, { title: string }[]> };
    expect(body.pending.patchwork?.some((p) => p.title === "wire route")).toBe(true);
  });

  test("?pending=0 (or any other value) does NOT opt in — only the literal '1' does", async () => {
    const res = handleRosterRequest(new Request("http://x/api/roster?company=kobo&pending=0"));
    const body = (await res.json()) as { pending: Record<string, unknown[]> };
    expect(body.pending).toEqual({});
  });
});
