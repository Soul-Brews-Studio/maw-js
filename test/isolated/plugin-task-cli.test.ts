import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runTask } from "../../src/vendor/mpr-plugins/task/index";
import { listTasks, readTask } from "../../src/core/tasks/store";

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

  test("missing id / unknown subcommand → clean error, not a throw", async () => {
    expect((await run(["claim", "--company", "pgw"])).error).toContain("usage");
    expect((await run(["bogus"])).ok).toBe(false);
    expect((await run(["done", "pgw-999", "--company", "pgw"])).error).toContain("not found");
    expect(listTasks("pgw")).toEqual([]);
  });
});
