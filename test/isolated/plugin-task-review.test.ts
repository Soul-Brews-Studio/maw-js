import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import handler from "../../src/vendor/mpr-plugins/task/index";
import { readTask } from "../../src/core/tasks/store";

// In-process handler test for the `maw task` plugin (Track 4). The plugin is
// loaded from source here, so this reliably tests CURRENT code — a subprocess
// `maw task` would load the INSTALLED plugin (a deploy artifact), so binary
// verify of the CLI belongs to the post-merge deploy step, not CI.

const dir = mkdtempSync(join(tmpdir(), "maw-taskrev-"));
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

const run = (args: string[]) =>
  handler({ source: "cli", args } as never) as Promise<{ ok: boolean; error?: string; output?: string }>;
// every call passes --from local:eq3 → actor resolves to the real oracle, not the node default
const task = (args: string[]) => run([...args, "--company", "kobo", "--from", "local:eq3"]);

describe("maw task review + actor + next-action (Track 4)", () => {
  test("actor = real oracle via --from (by=eq3, not the node default mawjs)", async () => {
    await task(["add", "ship the thing"]);
    expect(readTask("kobo", "kobo-1")!.by).toBe("eq3");
    expect(readTask("kobo", "kobo-1")!.title).toBe("ship the thing"); // flag values don't leak
  });

  test("review --to → review state + reviewer + ping", async () => {
    await task(["add", "ship it"]);
    const r = await task(["review", "kobo-1", "--to", "patchwork", "--reason", "check logic"]);
    expect(r.ok).toBe(true);
    const t = readTask("kobo", "kobo-1")!;
    expect(t.state).toBe("review");
    expect(t.reviewer).toBe("patchwork");
    expect(t.reviewReason).toBe("check logic");
  });

  test("ls renders a next-action line for every card (no dead-end)", async () => {
    await task(["add", "a"]);
    await task(["review", "kobo-1", "--to", "patchwork"]);
    const r = await task(["ls"]);
    expect(r.output).toContain("kobo-1");
    expect(r.output).toContain("รอ patchwork ตรวจ"); // review next-action
  });

  test("review of a missing id → clean error", async () => {
    const r = await task(["review", "kobo-999"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not found");
  });
});
