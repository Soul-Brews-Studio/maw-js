import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MARKER_START,
  MARKER_END,
  buildDeptBlock,
  upsertManagedBlock,
  removeManagedBlock,
  writeDeptBlock,
  removeDeptBlockFromRepo,
} from "../src/vendor/mpr-plugins/company/company-claudemd";
import { resetGhqRootCache } from "../src/config/ghq-root";

describe("buildDeptBlock", () => {
  test("includes Lead line when a lead is given; tag format is dept:<co>:<dept>", () => {
    const block = buildDeptBlock({ company: "kob", dept: "payment", role: "dev", lead: "pay-lead" });
    expect(block.startsWith(MARKER_START)).toBe(true);
    expect(block.endsWith(MARKER_END)).toBe(true);
    expect(block).toContain("## Department");
    expect(block).toContain("- Company: kob");
    expect(block).toContain("- Department: payment (dept:kob:payment)");
    expect(block).toContain("- Role: dev");
    expect(block).toContain("- Lead: pay-lead");
  });

  test("omits Lead line when no lead", () => {
    const block = buildDeptBlock({ company: "kob", dept: "payment", role: "dev" });
    expect(block).not.toContain("- Lead:");
  });

  test("honors an explicit deptTag override", () => {
    const block = buildDeptBlock({ company: "kob", dept: "pay", deptTag: "dept:kob:pay", role: "qa" });
    expect(block).toContain("- Department: pay (dept:kob:pay)");
  });
});

describe("upsertManagedBlock", () => {
  const block = buildDeptBlock({ company: "kob", dept: "payment", role: "dev", lead: "pay-lead" });

  test("appends when absent, separated by one blank line", () => {
    const out = upsertManagedBlock("# Title\n\nbody text\n", block);
    expect(out).toContain("body text\n\n" + MARKER_START);
    expect(out.endsWith(MARKER_END + "\n")).toBe(true);
  });

  test("appends to empty content", () => {
    const out = upsertManagedBlock("", block);
    expect(out).toBe(block + "\n");
  });

  test("replaces in place when present", () => {
    const once = upsertManagedBlock("# Title\n\nbody\n", block);
    const newBlock = buildDeptBlock({ company: "kob", dept: "frontend", role: "qa" });
    const twice = upsertManagedBlock(once, newBlock);
    expect(twice).toContain("- Department: frontend (dept:kob:frontend)");
    expect(twice).not.toContain("- Department: payment");
    // exactly one block
    expect(twice.split(MARKER_START).length - 1).toBe(1);
    expect(twice.split(MARKER_END).length - 1).toBe(1);
  });

  test("idempotent — twice with same block equals once", () => {
    const once = upsertManagedBlock("# Title\n\nbody\n", block);
    const twice = upsertManagedBlock(once, block);
    expect(twice).toBe(once);
  });

  test("does not touch surrounding content (before + after preserved)", () => {
    const seeded =
      "# Title\n\nintro\n\n" + block + "\n\n## Footer\n\ntail content\n";
    const newBlock = buildDeptBlock({ company: "kob", dept: "qa", role: "lead", lead: "qa-lead" });
    const out = upsertManagedBlock(seeded, newBlock);
    expect(out).toContain("# Title");
    expect(out).toContain("intro");
    expect(out).toContain("## Footer");
    expect(out).toContain("tail content");
    expect(out).toContain("- Department: qa (dept:kob:qa)");
    expect(out).not.toContain("- Department: payment");
  });

  test("role/lead change updates only the block", () => {
    const seeded = "before\n\n" + block + "\n\nafter\n";
    const changed = buildDeptBlock({ company: "kob", dept: "payment", role: "lead", lead: "pay-lead" });
    const out = upsertManagedBlock(seeded, changed);
    expect(out).toContain("- Role: lead");
    expect(out).not.toContain("- Role: dev");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });
});

describe("removeManagedBlock", () => {
  const block = buildDeptBlock({ company: "kob", dept: "payment", role: "dev" });

  test("removes the block, preserving surrounding content", () => {
    const seeded = "# Title\n\nintro\n\n" + block + "\n\n## Footer\n\ntail\n";
    const out = removeManagedBlock(seeded);
    expect(out).not.toContain(MARKER_START);
    expect(out).not.toContain(MARKER_END);
    expect(out).toContain("# Title");
    expect(out).toContain("intro");
    expect(out).toContain("## Footer");
    expect(out).toContain("tail");
  });

  test("no-op when block absent", () => {
    const content = "# Title\n\njust content\n";
    expect(removeManagedBlock(content)).toBe(content);
  });

  test("removing then any content remains valid (block-only file)", () => {
    const out = removeManagedBlock(block + "\n");
    expect(out).not.toContain(MARKER_START);
    expect(out.trim()).toBe("");
  });
});

describe("writeDeptBlock / removeDeptBlockFromRepo (temp dir)", () => {
  let repo = "";
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "maw-claudemd-"));
  });
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  test("creates CLAUDE.md with the block when none exists", () => {
    const ok = writeDeptBlock(repo, { company: "kob", dept: "payment", role: "dev" });
    expect(ok).toBe(true);
    const content = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(content).toContain(MARKER_START);
    expect(content).toContain("- Company: kob");
  });

  test("upserts into an existing CLAUDE.md without clobbering content", () => {
    writeFileSync(join(repo, "CLAUDE.md"), "# Oracle\n\nidentity stuff\n");
    writeDeptBlock(repo, { company: "kob", dept: "payment", role: "dev", lead: "pay-lead" });
    const content = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(content).toContain("# Oracle");
    expect(content).toContain("identity stuff");
    expect(content).toContain("- Lead: pay-lead");
  });

  test("reassign updates block in place — no duplication", () => {
    writeDeptBlock(repo, { company: "kob", dept: "payment", role: "dev" });
    writeDeptBlock(repo, { company: "kob", dept: "frontend", role: "qa" });
    const content = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(content.split(MARKER_START).length - 1).toBe(1);
    expect(content).toContain("- Department: frontend (dept:kob:frontend)");
    expect(content).not.toContain("- Department: payment");
  });

  test("removeDeptBlockFromRepo strips the block but keeps content", () => {
    writeFileSync(join(repo, "CLAUDE.md"), "# Oracle\n\nkeep me\n");
    writeDeptBlock(repo, { company: "kob", dept: "payment", role: "dev" });
    const ok = removeDeptBlockFromRepo(repo);
    expect(ok).toBe(true);
    const content = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(content).not.toContain(MARKER_START);
    expect(content).toContain("keep me");
  });

  test("removeDeptBlockFromRepo is a no-op (false) when no CLAUDE.md", () => {
    expect(removeDeptBlockFromRepo(repo)).toBe(false);
  });

  test("write returns false (no throw) when repo dir is missing", () => {
    const missing = join(repo, "does-not-exist");
    expect(writeDeptBlock(missing, { company: "kob", dept: "payment", role: "dev" })).toBe(false);
    expect(existsSync(join(missing, "CLAUDE.md"))).toBe(false);
  });

  test("remove returns false (no throw) when repo dir is missing", () => {
    expect(removeDeptBlockFromRepo(join(repo, "nope"))).toBe(false);
  });
});

describe("assign → CLAUDE.md block lands; remove → gone (fleet + repo integration)", () => {
  let home = "";
  let ghqRoot = "";
  const origHome = process.env.MAW_HOME;
  const origGhq = process.env.GHQ_ROOT;
  let companiesDir = "";

  // Lazy import to avoid load-order issues with env.
  function reqHelpers() {
    return require("../src/vendor/mpr-plugins/company/company-helpers");
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "maw-cmd-int-"));
    ghqRoot = mkdtempSync(join(tmpdir(), "maw-ghq-int-"));
    process.env.MAW_HOME = home;
    process.env.GHQ_ROOT = ghqRoot;
    resetGhqRootCache();
    companiesDir = join(home, "companies");
    reqHelpers()._setCompaniesDir(companiesDir);

    // Fleet config: oracle "payment-dev" → repo acme/payment-dev-oracle
    const fleetDir = join(home, "fleet");
    mkdirSync(fleetDir, { recursive: true });
    writeFileSync(
      join(fleetDir, "01-payment-dev.json"),
      JSON.stringify(
        { name: "01-payment-dev", windows: [{ name: "payment-dev-oracle", repo: "acme/payment-dev-oracle" }] },
        null,
        2,
      ) + "\n",
    );
    // The repo dir must exist for resolveOracleRepoPath to return it.
    mkdirSync(join(ghqRoot, "github.com", "acme", "payment-dev-oracle"), { recursive: true });
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.MAW_HOME;
    else process.env.MAW_HOME = origHome;
    if (origGhq === undefined) delete process.env.GHQ_ROOT;
    else process.env.GHQ_ROOT = origGhq;
    if (home) rmSync(home, { recursive: true, force: true });
    if (ghqRoot) rmSync(ghqRoot, { recursive: true, force: true });
    resetGhqRootCache();
  });

  test("assignMember writes the block; removeMember strips it", () => {
    const h = reqHelpers();
    h.createCompany("kob");
    h.addDepartment("kob", "payment");
    h.assignMember("kob", "payment", "payment-dev", "dev");

    const claudeMd = join(ghqRoot, "github.com", "acme", "payment-dev-oracle", "CLAUDE.md");
    expect(existsSync(claudeMd)).toBe(true);
    let content = readFileSync(claudeMd, "utf-8");
    expect(content).toContain(MARKER_START);
    expect(content).toContain("- Company: kob");
    expect(content).toContain("- Department: payment (dept:kob:payment)");
    expect(content).toContain("- Role: dev");

    h.removeMember("kob", "payment", "payment-dev");
    content = readFileSync(claudeMd, "utf-8");
    expect(content).not.toContain(MARKER_START);
  });

  test("repo-not-found path warns without crashing (no fleet repo on disk)", () => {
    const h = reqHelpers();
    h.createCompany("kob");
    h.addDepartment("kob", "payment");
    // ghost has no fleet entry → resolveOracleRepoPath null → assign still works
    // (also no fleet config, so syncOracleAssignment short-circuits false; use a
    // real member with a non-existent repo to exercise the warn path).
    rmSync(join(ghqRoot, "github.com", "acme", "payment-dev-oracle"), { recursive: true });
    expect(() => h.assignMember("kob", "payment", "payment-dev", "dev")).not.toThrow();
  });
});
