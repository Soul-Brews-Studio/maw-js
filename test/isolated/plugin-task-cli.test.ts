import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runTask } from "../../src/vendor/mpr-plugins/task/index";
import { listArchivedTasks, listTasks, readTask } from "../../src/core/tasks/store";

// Behavioural test for the task-board runner `runTask` — the shared engine that
// `maw company task` (and the maw_task MCP tool) drive. cli-reorg kobo-26 removed
// the top-level `maw task` command, so we exercise the runner directly (no
// default handler). No --assignee is used, so no ping ever fires — hermetic.

const dir = mkdtempSync(join(tmpdir(), "maw-taskcli-"));
const prev = process.env.MAW_DATA_DIR;

beforeAll(() => { process.env.MAW_DATA_DIR = dir; });
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { rmSync(join(dir, "companies"), { recursive: true, force: true }); });

// Collect emitted lines into `output` so the same assertions (output/ok/error) hold.
const run = async (args: string[]): Promise<{ ok: boolean; error?: string; output: string }> => {
  const out: string[] = [];
  const r = await runTask(args, (l) => out.push(l));
  return { ...r, output: out.join("\n") };
};

describe("maw company task runner (runTask)", () => {
  test("add stores ONLY the title — flag values never leak into it (regression)", async () => {
    const r = await run(["add", "ship the board", "--company", "pgw", "--dept", "core", "--epic", "kanban"]);
    expect(r.ok).toBe(true);
    const t = readTask("pgw", "pgw-1")!;
    expect(t.title).toBe("ship the board");
    expect(t.dept).toBe("core");
    expect(t.epic).toBe("kanban");
    expect(t.state).toBe("todo");
  });

  test("claim then done move the card through states", async () => {
    await run(["add", "task one", "--company", "pgw"]);
    expect((await run(["claim", "pgw-1", "--company", "pgw"])).ok).toBe(true);
    expect(readTask("pgw", "pgw-1")!.state).toBe("in-progress");
    expect((await run(["done", "pgw-1", "--company", "pgw"])).ok).toBe(true);
    expect(readTask("pgw", "pgw-1")!.state).toBe("done");
  });

  test("ls --mine filters to the caller's assigned cards", async () => {
    await run(["add", "unassigned", "--company", "pgw"]);
    await run(["add", "mine", "--company", "pgw"]);
    await run(["claim", "pgw-2", "--company", "pgw"]); // caller claims pgw-2
    const all = await run(["ls", "--company", "pgw"]);
    const mine = await run(["ls", "--company", "pgw", "--mine"]);
    expect(all.output).toContain("unassigned");
    expect(mine.output).toContain("mine");
    expect(mine.output).not.toContain("unassigned");
  });

  test("archive <id> moves ONE card off the board into archive/ (kobo-35)", async () => {
    await run(["add", "keep me", "--company", "pgw"]);       // pgw-1
    await run(["add", "review me", "--company", "pgw"]);     // pgw-2
    await run(["done", "pgw-2", "--company", "pgw"]);
    const r = await run(["archive", "pgw-2", "--company", "pgw"]);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("archived");
    expect(r.output).toContain("pgw-2");
    // gone from the active store, preserved in archive/ (principle 1) — never deleted
    expect(readTask("pgw", "pgw-2")).toBeNull();
    expect(listTasks("pgw").map((t) => t.id)).toEqual(["pgw-1"]);
    expect(listArchivedTasks("pgw").map((t) => t.id)).toContain("pgw-2");
  });

  test("archive <id> for a missing card → clean error, not a throw", async () => {
    const r = await run(["archive", "pgw-999", "--company", "pgw"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not found");
  });

  test("archive with no id still runs the bulk --days sweep (unchanged)", async () => {
    await run(["add", "fresh done", "--company", "pgw"]); // pgw-1
    await run(["done", "pgw-1", "--company", "pgw"]);
    const r = await run(["archive", "--company", "pgw"]); // default window — nothing old enough
    expect(r.ok).toBe(true);
    expect(r.output).toContain("nothing to archive");
    expect(readTask("pgw", "pgw-1")!.state).toBe("done"); // recent done stays on the board
  });

  test("add --kind epic marks a container card; default add is a plain task (kobo-72)", async () => {
    expect((await run(["add", "the epic", "--company", "pgw", "--kind", "epic"])).ok).toBe(true);
    expect(readTask("pgw", "pgw-1")!.kind).toBe("epic");
    await run(["add", "a task", "--company", "pgw"]); // pgw-2, no --kind
    expect(readTask("pgw", "pgw-2")!.kind).toBeUndefined(); // task is the default (not persisted)
    const bad = await run(["add", "nope", "--company", "pgw", "--kind", "bogus"]);
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("epic or task");
  });

  test("epic <id> <epicId> sets containment; --clear removes it (kobo-72)", async () => {
    await run(["add", "parent epic", "--company", "pgw", "--kind", "epic"]); // pgw-1
    await run(["add", "child", "--company", "pgw"]);                          // pgw-2
    const set = await run(["epic", "pgw-2", "pgw-1", "--company", "pgw"]);
    expect(set.ok).toBe(true);
    expect(readTask("pgw", "pgw-2")!.epic).toBe("pgw-1");
    const clr = await run(["epic", "pgw-2", "--clear", "--company", "pgw"]);
    expect(clr.ok).toBe(true);
    expect(readTask("pgw", "pgw-2")!.epic).toBeUndefined();
  });

  test("epic re-links a same-id dependency onto containment (the hand-edit gap, kobo-72)", async () => {
    await run(["add", "epic", "--company", "pgw", "--kind", "epic"]);              // pgw-1
    await run(["add", "child", "--company", "pgw", "--parent", "pgw-1"]);          // pgw-2 wrongly dep'd on pgw-1
    expect(readTask("pgw", "pgw-2")!.parentIds).toEqual(["pgw-1"]);
    await run(["epic", "pgw-2", "pgw-1", "--company", "pgw"]);
    const t = readTask("pgw", "pgw-2")!;
    expect(t.epic).toBe("pgw-1");
    expect(t.parentIds).toBeUndefined(); // stale dep on the same id dropped
  });

  test("epic rejects a containment loop; usage/not-found errors are clean (kobo-72)", async () => {
    await run(["add", "a", "--company", "pgw"]); // pgw-1
    await run(["add", "b", "--company", "pgw"]); // pgw-2
    await run(["epic", "pgw-2", "pgw-1", "--company", "pgw"]); // b under a
    const loop = await run(["epic", "pgw-1", "pgw-2", "--company", "pgw"]); // a under b → cycle
    expect(loop.ok).toBe(false);
    expect(loop.error).toMatch(/loop/i);
    expect((await run(["epic", "pgw-1", "--company", "pgw"])).error).toContain("usage"); // no epicId, no --clear
    expect((await run(["epic", "pgw-999", "pgw-1", "--company", "pgw"])).error).toContain("not found");
  });

  test("pr links a card + stamps repo from the PR url; --repo overrides (kobo-80)", async () => {
    await run(["add", "url card", "--company", "pgw"]); // pgw-1, no repo
    const r = await run(["pr", "pgw-1", "https://github.com/meganechan/maw-js/pull/106", "--company", "pgw"]);
    expect(r.ok).toBe(true);
    const t = readTask("pgw", "pgw-1")!;
    expect(t.pr).toBe(106);
    expect(t.repo).toBe("meganechan/maw-js"); // stamped from the url → pr-watch can now poll it
    expect(t.state).toBe("review");

    await run(["add", "override card", "--company", "pgw"]); // pgw-2
    await run(["pr", "pgw-2", "5", "--repo", "acme/thing", "--company", "pgw"]);
    expect(readTask("pgw", "pgw-2")!.repo).toBe("acme/thing"); // explicit --repo with a bare number
  });

  test("pr rejects a bare repo (no owner) — an unpollable link never binds (kobo-99)", async () => {
    await run(["add", "bare repo card", "--company", "pgw"]); // pgw-1
    const r = await run(["pr", "pgw-1", "5", "--repo", "helm-charts", "--company", "pgw"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("owner/name");
    // link rejected → card untouched (no pr, still todo), not silently bound to an
    // unpollable repo that gh pr list would error on
    expect(readTask("pgw", "pgw-1")!.pr).toBeUndefined();
    expect(readTask("pgw", "pgw-1")!.state).toBe("todo");
  });

  test("missing id / unknown subcommand → clean error, not a throw", async () => {
    expect((await run(["claim", "--company", "pgw"])).error).toContain("usage");
    expect((await run(["bogus"])).ok).toBe(false);
    expect((await run(["done", "pgw-999", "--company", "pgw"])).error).toContain("not found");
    expect(listTasks("pgw")).toEqual([]);
  });
});
