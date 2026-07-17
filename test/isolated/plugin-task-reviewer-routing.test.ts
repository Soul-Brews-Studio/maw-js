import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runTask } from "../../src/vendor/mpr-plugins/task/index";
import {
  addTask,
  readTask,
  resolveReviewer,
  isSelfReview,
  prOpenedReview,
} from "../../src/core/tasks/store";
import { handleTaskEditRequest } from "../../src/core/tasks/route";

// kobo-328: reviewer-routing — executor≠reviewer enforced at the SSOT (resolveReviewer)
// so a review is NEVER routed back to the card's own doer, plus loud REFUSE on an
// explicit self-review dispatch (CLI --to / web edit). In-process against the store
// fns + runTask engine + the web edit handler. Loaded from source = CURRENT code.

const dir = mkdtempSync(join(tmpdir(), "maw-revroute-"));
const prev = process.env.MAW_DATA_DIR;

beforeAll(() => {
  process.env.MAW_DATA_DIR = dir;
  mkdirSync(join(dir, "companies"), { recursive: true });
  writeFileSync(
    join(dir, "companies", "kobo.json"),
    JSON.stringify({ name: "kobo", departments: { core: { members: [{ oracle: "eq3" }, { oracle: "patchwork" }], lead: "eq3" } } }),
  );
});
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { rmSync(join(dir, "companies", "kobo", "tasks"), { recursive: true, force: true }); });

const run = async (args: string[]): Promise<{ ok: boolean; error?: string; output: string }> => {
  const out: string[] = [];
  const r = await runTask(args, (l) => out.push(l));
  return { ...r, output: out.join("\n") };
};
const task = (args: string[]) => run([...args, "--company", "kobo", "--from", "local:eq3"]);

describe("kobo-328: resolveReviewer never routes to the executor (SSOT)", () => {
  test("explicit reviewer, independent → returned as-is", () => {
    const t = addTask({ company: "kobo", title: "c", by: "eq3", assignee: "patchwork", reviewer: "eq3" });
    expect(resolveReviewer(t)).toBe("eq3");
  });

  test("explicit reviewer === assignee → downgrades (never the doer)", () => {
    // a dirty --to/web-edit that set reviewer=the doer must NOT route review back to them
    const t = addTask({ company: "kobo", title: "c", by: "eq3", assignee: "patchwork", reviewer: "patchwork" });
    expect(resolveReviewer(t)).toBe("eq3"); // falls to creator (independent)
  });

  test("no explicit reviewer, creator ≠ doer → creator reviews", () => {
    const t = addTask({ company: "kobo", title: "c", by: "eq3", assignee: "patchwork" });
    expect(resolveReviewer(t)).toBe("eq3");
  });

  test("creator IS the doer + reviewer=doer → no independent reviewer → human", () => {
    const t = addTask({ company: "kobo", title: "c", by: "patchwork", assignee: "patchwork", reviewer: "patchwork" });
    expect(resolveReviewer(t)).toBe("human");
  });

  test("isSelfReview: true iff who is the assignee", () => {
    const t = addTask({ company: "kobo", title: "c", by: "eq3", assignee: "patchwork" });
    expect(isSelfReview(t, "patchwork")).toBe(true);
    expect(isSelfReview(t, "eq3")).toBe(false);
  });
});

describe("kobo-328: prOpenedReview never persists the doer as reviewer", () => {
  test("explicit reviewer === doer → downgrades to creator", () => {
    addTask({ company: "kobo", title: "c", by: "eq3", assignee: "patchwork" });
    const t = prOpenedReview("kobo", "kobo-1", "patchwork", "patchwork")!; // explicit self-review arg
    expect(t.reviewer).toBe("eq3"); // creator, not the doer
  });

  test("independent explicit reviewer → honored", () => {
    addTask({ company: "kobo", title: "c", by: "eq3", assignee: "patchwork" });
    const t = prOpenedReview("kobo", "kobo-1", "patchwork", "mawjs")!;
    expect(t.reviewer).toBe("mawjs");
  });
});

describe("kobo-328: CLI review dispatch refuses self-review", () => {
  test("review --to <assignee> → REFUSE (executor≠reviewer)", async () => {
    await task(["add", "c", "--assignee", "patchwork"]);
    const r = await task(["review", "kobo-1", "--to", "patchwork"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("self-review banned");
  });

  test("review --to <independent> → ok, pings the reviewer", async () => {
    await task(["add", "c", "--assignee", "patchwork"]);
    const r = await task(["review", "kobo-1", "--to", "eq3"]);
    expect(r.ok).toBe(true);
    expect(readTask("kobo", "kobo-1")!.reviewer).toBe("eq3");
  });

  test("plain review, creator === doer → warns no independent reviewer (falls to human)", async () => {
    // eq3 creates AND is the doer → no independent reviewer
    await task(["add", "c", "--assignee", "eq3"]);
    const r = await task(["review", "kobo-1"]);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("no independent reviewer");
  });
});

describe("kobo-328: web parity (Board Truth #7)", () => {
  const edit = (payload: object) =>
    handleTaskEditRequest(new Request("http://x/api/tasks/edit", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    }));

  test("web edit refuses reviewer === assignee (409)", async () => {
    addTask({ company: "kobo", title: "c", by: "eq3", assignee: "patchwork" });
    const res = await edit({ company: "kobo", id: "kobo-1", reviewer: "patchwork" });
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.error).toContain("self-review banned");
  });

  test("web edit accepts an independent reviewer", async () => {
    addTask({ company: "kobo", title: "c", by: "eq3", assignee: "patchwork" });
    const res = await edit({ company: "kobo", id: "kobo-1", reviewer: "eq3" });
    expect(res.status).toBe(200);
  });

  test("toCard exposes the RESOLVED reviewer (never the doer)", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/core/tasks/route.ts"), "utf8");
    expect(src).toContain("const rv = resolveReviewer(t)"); // web uses the same SSOT as CLI
    expect(src).toContain('if (rv !== "human") card.reviewer = rv');
  });
});
