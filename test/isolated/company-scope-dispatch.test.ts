import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// kobo-341: cross-company dispatch guard. A card's assignee/reviewer/handoff must be
// reachable WITHIN the card's company — a member (dept oracle or the company manager) or
// a human — else the notify path pings a cross-company fleet pane (kobo-334). Hermetic:
// sandbox MAW_DATA_DIR + MAW_TEST_MODE (no live delivery) + CLAUDE_AGENT_NAME=eq3 (the
// manager acting as itself, satisfying kobo-335 actor-auth).

const dir = mkdtempSync(join(tmpdir(), "maw-coscope-"));
const prev = process.env.MAW_DATA_DIR;
const prevAgent = process.env.CLAUDE_AGENT_NAME;
const prevTest = process.env.MAW_TEST_MODE;
// MUST set BEFORE importing — company-helpers caches COMPANIES_DIR at module load, so the
// scope guard's loadCompany reads THIS sandbox, not the real ~/.maw/companies.
process.env.MAW_DATA_DIR = dir;
mkdirSync(join(dir, "companies"), { recursive: true });
// pgw: manager=eq3 (above depts), dept core members thawanban + somsri. patchwork NOT a member.
writeFileSync(join(dir, "companies", "pgw.json"),
  JSON.stringify({ name: "pgw", manager: "eq3", departments: { core: { members: [{ oracle: "thawanban" }, { oracle: "somsri" }], lead: "thawanban" } } }));

const { runTask } = await import("../../src/vendor/mpr-plugins/task/index");
const { readTask } = await import("../../src/core/tasks/store");
const { companyScopeViolation } = await import("../../src/core/worklog/company-scope");
const { COMPANIES_DIR, _setCompaniesDir } = await import("../../src/vendor/mpr-plugins/company/company-helpers");
const prevCompaniesDir = COMPANIES_DIR;

// CLAUDE_AGENT_NAME + MAW_TEST_MODE read at call-time → beforeAll (no top-level bleed, kobo-335).
// COMPANIES_DIR is shared module state cached by the FIRST importer in a batch, so top-level
// MAW_DATA_DIR-before-import isn't enough — point it at THIS sandbox explicitly + restore.
beforeAll(() => {
  process.env.CLAUDE_AGENT_NAME = "eq3";
  process.env.MAW_TEST_MODE = "1";
  _setCompaniesDir(join(dir, "companies"));
});
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR; else process.env.MAW_DATA_DIR = prev;
  if (prevAgent === undefined) delete process.env.CLAUDE_AGENT_NAME; else process.env.CLAUDE_AGENT_NAME = prevAgent;
  if (prevTest === undefined) delete process.env.MAW_TEST_MODE; else process.env.MAW_TEST_MODE = prevTest;
  _setCompaniesDir(prevCompaniesDir);
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { rmSync(join(dir, "companies", "pgw", "tasks"), { recursive: true, force: true }); });

const run = async (args: string[]) => {
  const out: string[] = [];
  const r = await runTask(args, (l) => out.push(l));
  return { ...r, output: out.join("\n") };
};
const task = (args: string[]) => run([...args, "--company", "pgw", "--from", "local:eq3"]);

describe("kobo-341 companyScopeViolation (unit)", () => {
  test("dept member → allowed (null)", () => expect(companyScopeViolation("pgw", "thawanban")).toBeNull());
  test("company manager (above depts) → allowed", () => expect(companyScopeViolation("pgw", "eq3")).toBeNull());
  test("human / tony / any → allowed", () => {
    expect(companyScopeViolation("pgw", "human")).toBeNull();
    expect(companyScopeViolation("pgw", "tony")).toBeNull();
    expect(companyScopeViolation("pgw", "any")).toBeNull();
  });
  test("empty / undefined → allowed (nothing to guard)", () => {
    expect(companyScopeViolation("pgw", "")).toBeNull();
    expect(companyScopeViolation("pgw", undefined)).toBeNull();
  });
  test("oracle fully outside company → REFUSE with clear error", () => {
    const v = companyScopeViolation("pgw", "patchwork");
    expect(v).not.toBeNull();
    expect(v).toContain("patchwork");
    expect(v).toContain("pgw");
    expect(v).toContain("cross-company");
  });
});

describe("kobo-341 write-time guard via runTask", () => {
  test("assign --to cross-company → REFUSE (the kobo-334 vector)", async () => {
    await task(["add", "c"]);
    const r = await task(["assign", "pgw-1", "--to", "patchwork"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("cross-company");
    expect(readTask("pgw", "pgw-1")!.assignee).not.toBe("patchwork"); // never persisted (stays default null)
  });

  test("assign --to a dept member → allowed", async () => {
    await task(["add", "c"]);
    const r = await task(["assign", "pgw-1", "--to", "somsri"]);
    expect(r.ok).toBe(true);
    expect(readTask("pgw", "pgw-1")!.assignee).toBe("somsri");
  });

  test("assign --to the company manager (not-in-dept) → allowed (rule 14 lead)", async () => {
    await task(["add", "c"]);
    expect((await task(["assign", "pgw-1", "--to", "eq3"])).ok).toBe(true);
  });

  test("assign --to human → allowed", async () => {
    await task(["add", "c"]);
    expect((await task(["assign", "pgw-1", "--to", "human"])).ok).toBe(true);
  });

  test("add --assignee cross-company → REFUSE (no card created)", async () => {
    const r = await task(["add", "c", "--assignee", "patchwork"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("cross-company");
    expect(readTask("pgw", "pgw-1")).toBeNull();
  });

  test("add --reviewer cross-company → REFUSE", async () => {
    const r = await task(["add", "c", "--reviewer", "mawjs"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("cross-company");
  });

  test("review --to cross-company → REFUSE (reviewer parity)", async () => {
    await task(["add", "c", "--assignee", "somsri"]);
    const r = await task(["review", "pgw-1", "--to", "patchwork"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("cross-company");
  });

  test("review --to a member → allowed", async () => {
    await task(["add", "c", "--assignee", "somsri"]);
    expect((await task(["review", "pgw-1", "--to", "thawanban"])).ok).toBe(true);
  });

  test("ask --to cross-company → REFUSE", async () => {
    await task(["add", "parent", "--kind", "epic"]);
    const r = await task(["ask", "pgw-1", "decide?", "--to", "patchwork"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("cross-company");
  });

  test("decompose child assignee cross-company → REFUSE, no child cards created (crew .2 gap)", async () => {
    await task(["add", "epic", "--kind", "epic"]); // pgw-1 epic
    const plan = JSON.stringify([{ title: "legit child", assignee: "somsri" }, { title: "forged child", assignee: "patchwork" }]);
    const r = await task(["decompose", "pgw-1", "--plan", plan]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("cross-company");
    expect(r.error).toContain("forged child"); // names the offending child
    // refuse-all: NO child cards materialized (only the epic pgw-1 exists)
    expect(readTask("pgw", "pgw-2")).toBeNull();
  });

  test("decompose child reviewer cross-company → REFUSE", async () => {
    await task(["add", "epic", "--kind", "epic"]);
    const plan = JSON.stringify([{ title: "child", assignee: "somsri", reviewer: "mawjs" }]);
    const r = await task(["decompose", "pgw-1", "--plan", plan]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("cross-company");
  });

  test("decompose all-member children → allowed", async () => {
    await task(["add", "epic", "--kind", "epic"]);
    const plan = JSON.stringify([{ title: "a", assignee: "somsri" }, { title: "b", assignee: "thawanban", reviewer: "eq3" }]);
    const r = await task(["decompose", "pgw-1", "--plan", plan]);
    expect(r.ok).toBe(true);
    expect(readTask("pgw", "pgw-2")).not.toBeNull(); // children materialized
  });
});
