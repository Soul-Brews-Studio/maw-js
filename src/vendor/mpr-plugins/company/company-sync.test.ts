import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { _setCompaniesDir, createCompany, addDepartment } from "./company-helpers";
import { syncCompanyPolicy, resolvePolicySource } from "./company-sync";

// ─── Sandbox ──────────────────────────────────────────────────────────────────

let companiesDir: string; // redirected COMPANIES_DIR
let repo: string; // fake manager repo holding policies/

beforeEach(() => {
  companiesDir = mkdtempSync(join(tmpdir(), "co-sync-data-"));
  repo = mkdtempSync(join(tmpdir(), "co-sync-repo-"));
  _setCompaniesDir(companiesDir);

  // Build the source manager repo: <repo>/policies/{company.md,core.md}
  mkdirSync(join(repo, "policies"), { recursive: true });
  writeFileSync(join(repo, "policies", "company.md"), "# Company Policy\nbe excellent\n");
  writeFileSync(join(repo, "policies", "core.md"), "# Core Dept\nship it\n");
});

afterEach(() => {
  rmSync(companiesDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("syncCompanyPolicy", () => {
  it("copies company.md + dept policy into destDir with correct content", () => {
    createCompany("kobo");
    addDepartment("kobo", "core");

    const res = syncCompanyPolicy("kobo", repo);

    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.sourceDir).toBe(join(repo, "policies"));
    expect(res.written.sort()).toEqual(["company.md", "core.md"]);
    expect(res.missing).toEqual([]);

    const destDir = join(companiesDir, "kobo", "policy");
    expect(readFileSync(join(destDir, "company.md"), "utf-8")).toBe(
      "# Company Policy\nbe excellent\n",
    );
    expect(readFileSync(join(destDir, "core.md"), "utf-8")).toBe("# Core Dept\nship it\n");
  });

  it("records a dept with no <dept>.md in missing, not as an error", () => {
    createCompany("kobo");
    addDepartment("kobo", "core");
    addDepartment("kobo", "qa"); // no qa.md in source

    const res = syncCompanyPolicy("kobo", repo);

    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.written.sort()).toEqual(["company.md", "core.md"]);
    expect(res.missing).toEqual(["qa.md"]);
  });

  it("returns ok:false with error for an unknown company", () => {
    const res = syncCompanyPolicy("ghost", repo);

    expect(res.ok).toBe(false);
    expect(res.error).toBe("company 'ghost' not found");
    expect(res.written).toEqual([]);
  });

  it("returns ok:false when the source cannot be resolved", () => {
    createCompany("kobo");

    const res = syncCompanyPolicy("kobo", "/no/such/path-xyz");

    expect(res.ok).toBe(false);
    expect(res.error).toBe("policy source not found: /no/such/path-xyz");
  });
});

describe("resolvePolicySource", () => {
  it("returns <dir>/policies for a real directory path", () => {
    expect(resolvePolicySource(repo)).toBe(join(repo, "policies"));
  });

  it("returns null for a non-existent path / unresolvable oracle", () => {
    expect(resolvePolicySource("/no/such/path-xyz")).toBeNull();
  });
});
