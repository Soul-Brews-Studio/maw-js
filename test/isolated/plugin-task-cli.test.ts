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

  test("missing id / unknown subcommand → clean error, not a throw", async () => {
    expect((await run(["claim", "--company", "pgw"])).error).toContain("usage");
    expect((await run(["bogus"])).ok).toBe(false);
    expect((await run(["done", "pgw-999", "--company", "pgw"])).error).toContain("not found");
    expect(listTasks("pgw")).toEqual([]);
  });
});
