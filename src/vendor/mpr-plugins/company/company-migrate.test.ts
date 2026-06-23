import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  _setCompaniesDir,
  createCompany,
  addDepartment,
  assignMember,
} from "./company-helpers";
import {
  MARKER_START,
  MARKER_END,
  buildDeptBlock,
  removeDeptBlockFromRepo,
} from "./company-claudemd";
import { migrateCompanyPolicy } from "./company-migrate";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maw-migrate-"));
  _setCompaniesDir(dir);
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("migrateCompanyPolicy — sweep loop (no fleet repos)", () => {
  // These fake oracles have no fleet entry, so resolveOracleRepoPath returns
  // null → every member is skipped with "no-repo" and nothing is changed.
  beforeEach(() => {
    createCompany("kob");
    addDepartment("kob", "payment");
    assignMember("kob", "payment", "pay-dev", "dev");
    assignMember("kob", "payment", "pay-qa", "qa");
  });

  test("each member with no resolvable repo → skippedReason 'no-repo'", () => {
    const res = migrateCompanyPolicy("kob", { dryRun: true, commit: false });
    expect(res.companies).toEqual(["kob"]);
    expect(res.changed).toBe(0);
    expect(res.outcomes.length).toBe(2);
    for (const o of res.outcomes) {
      expect(o.repoPath).toBeNull();
      expect(o.stripped).toBe(false);
      expect(o.committed).toBe(false);
      expect(o.skippedReason).toBe("no-repo");
    }
    expect(res.outcomes.map((o) => o.oracle).sort()).toEqual(["pay-dev", "pay-qa"]);
  });

  test("undefined company sweeps every registered company", () => {
    createCompany("acme");
    addDepartment("acme", "core");
    assignMember("acme", "core", "core-dev", "dev");

    const res = migrateCompanyPolicy(undefined, { dryRun: true, commit: false });
    expect(res.companies.sort()).toEqual(["acme", "kob"]);
    // 2 kob members + 1 acme member, all unresolved.
    expect(res.outcomes.length).toBe(3);
    expect(res.changed).toBe(0);
  });

  test("distinct oracles only — a member in two depts is swept once", () => {
    addDepartment("kob", "core");
    assignMember("kob", "core", "pay-dev", "lead"); // same oracle, second dept

    const res = migrateCompanyPolicy("kob", { dryRun: true, commit: false });
    const oracles = res.outcomes.map((o) => o.oracle).sort();
    expect(oracles).toEqual(["pay-dev", "pay-qa"]);
  });

  test("empty / unknown company yields no outcomes", () => {
    const res = migrateCompanyPolicy("ghost", { dryRun: true, commit: false });
    expect(res.companies).toEqual(["ghost"]);
    expect(res.outcomes).toEqual([]);
    expect(res.changed).toBe(0);
  });
});

describe("strip mechanics — removeDeptBlockFromRepo round-trip + dryRun detection", () => {
  let repo = "";
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "maw-migrate-repo-"));
  });
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  function seedWithBlock(): void {
    const block = buildDeptBlock({ company: "kob", dept: "payment", role: "dev", lead: "pay-lead" });
    writeFileSync(join(repo, "CLAUDE.md"), "# Oracle\n\nkeep me\n\n" + block + "\n");
  }

  test("removeDeptBlockFromRepo strips the marked block, preserving surrounding content", () => {
    seedWithBlock();
    const ok = removeDeptBlockFromRepo(repo);
    expect(ok).toBe(true);
    const content = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(content).not.toContain(MARKER_START);
    expect(content).not.toContain(MARKER_END);
    expect(content).toContain("keep me");
  });

  test("removeDeptBlockFromRepo is idempotent — no block → false (no-op)", () => {
    seedWithBlock();
    expect(removeDeptBlockFromRepo(repo)).toBe(true);
    expect(removeDeptBlockFromRepo(repo)).toBe(false);
  });

  test("dryRun MARKER_START detection — present vs absent", () => {
    // present
    seedWithBlock();
    let content = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(content.includes(MARKER_START)).toBe(true);

    // absent after strip
    removeDeptBlockFromRepo(repo);
    content = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(content.includes(MARKER_START)).toBe(false);
  });
});
