import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runTask, __setPrDiffFetcherForTest, __resetPrDiffFetcherForTest } from "../../src/vendor/mpr-plugins/task/index";
import { addTask, readTask, requiredSignTiers } from "../../src/core/tasks/store";

/**
 * kobo-546 REWORK — a DEDICATED, otherwise-untouched module load for one
 * question: with NOTHING injected, does `pr`/`merge` really shell to `gh`
 * through the real `fetchPrDiffFiles`, or is the default silently wired to a
 * stub? Deliberately its own file (own fresh module graph — `prDiffFetcher`'s
 * module-level default is verified before any OTHER test file's
 * `__setPrDiffFetcherForTest` could ever run). If the default were ever
 * pre-wired to a stub instead of the real fetcher, `Bun.spawnSync` below would
 * never be called and this test goes red.
 */
const dir = mkdtempSync(join(tmpdir(), "maw-prdifffetch-"));
const prev = process.env.MAW_DATA_DIR;
const prevAgent = process.env.CLAUDE_AGENT_NAME;
const prevTest = process.env.MAW_TEST_MODE;
const origSpawnSync = Bun.spawnSync;

beforeAll(() => {
  process.env.MAW_DATA_DIR = dir;
  process.env.CLAUDE_AGENT_NAME = "eq3";
  process.env.MAW_TEST_MODE = "1";
  mkdirSync(join(dir, "companies"), { recursive: true });
  writeFileSync(
    join(dir, "companies", "kobo.json"),
    JSON.stringify({ name: "kobo", departments: { core: { members: [{ oracle: "eq3" }], lead: "eq3" } } }),
  );
});
afterAll(() => {
  Bun.spawnSync = origSpawnSync;
  if (prev === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prev;
  if (prevAgent === undefined) delete process.env.CLAUDE_AGENT_NAME; else process.env.CLAUDE_AGENT_NAME = prevAgent;
  if (prevTest === undefined) delete process.env.MAW_TEST_MODE; else process.env.MAW_TEST_MODE = prevTest;
  rmSync(dir, { recursive: true, force: true });
});

const run = async (args: string[]) => runTask([...args, "--company", "kobo", "--from", "local:eq3"], () => {});

describe("prDiffFetcher default (kobo-546 rework) — must be the REAL fetcher, never a pre-wired stub", () => {
  test("with nothing injected, `pr` shells to the real gh (Bun.spawnSync IS called with `gh pr view ... --json files`)", async () => {
    let capturedArgv: string[] | undefined;
    Bun.spawnSync = ((argv: string[]) => {
      capturedArgv = argv;
      return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ files: [{ path: "docs/x.md", additions: 1, deletions: 0 }] })), stderr: Buffer.from("") };
    }) as typeof Bun.spawnSync;

    const t = addTask({ company: "kobo", title: "c", by: "eq3" });
    await run(["pr", t.id, "42", "--repo", "meganechan/maw-js"]);

    expect(capturedArgv).toBeDefined();
    expect(capturedArgv).toContain("gh");
    expect(capturedArgv).toContain("view");
    expect(capturedArgv).toContain("--json");
    expect(capturedArgv).toContain("files");
    expect(capturedArgv).toContain("42");
  });

  test("the real fetcher's result actually reaches the classifier — a sensitive-path stub from gh escalates crewGate", async () => {
    Bun.spawnSync = (() => ({
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify({ files: [{ path: "src/core/tasks/store.ts", additions: 1, deletions: 0 }] })),
      stderr: Buffer.from(""),
    })) as typeof Bun.spawnSync;

    const t = addTask({ company: "kobo", title: "c", by: "eq3" });
    await run(["pr", t.id, "43", "--repo", "meganechan/maw-js"]);
    expect(readTask("kobo", t.id)!.crewGate).toBe(true);
  });

  test("__setPrDiffFetcherForTest genuinely overrides the default — Bun.spawnSync is NOT called once injected", async () => {
    Bun.spawnSync = (() => { throw new Error("must not reach gh once a test fetcher is injected"); }) as typeof Bun.spawnSync;
    __setPrDiffFetcherForTest(() => [{ path: "docs/x.md", additions: 1, deletions: 0 }]);
    try {
      const t = addTask({ company: "kobo", title: "c", by: "eq3" });
      const r = await run(["pr", t.id, "44", "--repo", "meganechan/maw-js"]);
      expect(r.ok).toBe(true); // did not throw — the injected fetcher was used, not Bun.spawnSync
      expect(requiredSignTiers(readTask("kobo", t.id)!)).toEqual(["head"]);
    } finally {
      __resetPrDiffFetcherForTest();
    }
  });

  test("__resetPrDiffFetcherForTest genuinely restores the real fetcher — Bun.spawnSync is called again after reset", async () => {
    __setPrDiffFetcherForTest(() => [{ path: "docs/x.md", additions: 1, deletions: 0 }]);
    __resetPrDiffFetcherForTest();
    let called = false;
    Bun.spawnSync = ((argv: string[]) => {
      called = true;
      return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ files: [] })), stderr: Buffer.from("") };
    }) as typeof Bun.spawnSync;

    const t = addTask({ company: "kobo", title: "c", by: "eq3" });
    await run(["pr", t.id, "45", "--repo", "meganechan/maw-js"]);
    expect(called).toBe(true);
  });
});
