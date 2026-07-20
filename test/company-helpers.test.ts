import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  _setCompaniesDir,
  createCompany, deleteCompany, listCompanies, loadCompany, companyExists, companyPath,
  addDepartment, removeDepartment,
  assignMember, removeMember, departmentMembers,
  checkNamingCollision, kbTagFor, assertValidName,
} from "../src/vendor/mpr-plugins/company/company-helpers";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maw-company-"));
  _setCompaniesDir(dir);
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("company registry CRUD", () => {
  test("create writes a registry file and is loadable", () => {
    const c = createCompany("kob");
    expect(c).toEqual({ name: "kob", teams: {} });
    expect(companyExists("kob")).toBe(true);
    expect(existsSync(companyPath("kob"))).toBe(true);
    expect(loadCompany("kob")).toEqual({ name: "kob", teams: {} });
  });

  test("create rejects duplicate company", () => {
    createCompany("kob");
    expect(() => createCompany("kob")).toThrow("already exists");
  });

  test("create rejects invalid names", () => {
    expect(() => createCompany("9bad")).toThrow("invalid company name");
    expect(() => createCompany("has space")).toThrow("invalid company name");
  });

  test("ls returns companies sorted by name", () => {
    createCompany("zed");
    createCompany("acme");
    createCompany("kob");
    expect(listCompanies().map((c) => c.name)).toEqual(["acme", "kob", "zed"]);
  });

  test("delete removes the registry file", () => {
    createCompany("kob");
    deleteCompany("kob");
    expect(companyExists("kob")).toBe(false);
    expect(() => deleteCompany("kob")).toThrow("not found");
  });

  test("loadCompany returns null for unknown company", () => {
    expect(loadCompany("ghost")).toBeNull();
  });
});

describe("departments", () => {
  // kobo-363: kbTag dropped from the persisted Department shape (KB offline,
  // rrr is local and doesn't depend on it). kbTagFor() stays as a pure
  // generator function for callers that still need a derived KB tag string.
  test("add-dept creates a department (no kbTag persisted)", () => {
    createCompany("kob");
    addDepartment("kob", "payment");
    const c = loadCompany("kob")!;
    expect(c.teams.payment).toEqual({
      lead: undefined,
      members: [],
    });
    expect(kbTagFor("kob", "payment")).toBe("dept:kob:payment");
  });

  test("add-dept with --lead records the lead as a member", () => {
    createCompany("kob");
    addDepartment("kob", "payment", { lead: "payment-lead" });
    const d = loadCompany("kob")!.teams.payment;
    expect(d.lead).toBe("payment-lead");
    expect(d.members).toEqual([{ oracle: "payment-lead", role: "lead" }]);
  });

  test("add-dept rejects unknown company and duplicate dept", () => {
    expect(() => addDepartment("ghost", "payment")).toThrow("company 'ghost' not found");
    createCompany("kob");
    addDepartment("kob", "payment");
    expect(() => addDepartment("kob", "payment")).toThrow("already exists");
  });

  test("rm-dept drops the department", () => {
    createCompany("kob");
    addDepartment("kob", "payment");
    removeDepartment("kob", "payment");
    expect(loadCompany("kob")!.teams.payment).toBeUndefined();
    expect(() => removeDepartment("kob", "payment")).toThrow("not found");
  });
});

describe("department members (assign / members / remove)", () => {
  beforeEach(() => {
    createCompany("kob");
    addDepartment("kob", "payment");
  });

  test("assign adds a member with a role", () => {
    const res = assignMember("kob", "payment", "payment-dev", "dev");
    expect(res.alreadyMember).toBe(false);
    expect(departmentMembers("kob", "payment")).toEqual([
      { oracle: "payment-dev", role: "dev" },
    ]);
  });

  test("assign defaults role to dev and updates role on re-assign", () => {
    assignMember("kob", "payment", "p1");
    expect(departmentMembers("kob", "payment")).toEqual([{ oracle: "p1", role: "dev" }]);
    const res = assignMember("kob", "payment", "p1", "qa");
    expect(res.alreadyMember).toBe(true);
    expect(departmentMembers("kob", "payment")).toEqual([{ oracle: "p1", role: "qa" }]);
  });

  test("assign with lead role updates the department lead pointer", () => {
    assignMember("kob", "payment", "boss", "lead");
    expect(loadCompany("kob")!.teams.payment.lead).toBe("boss");
  });

  test("assign rejects unknown company / department", () => {
    expect(() => assignMember("ghost", "payment", "x")).toThrow("company 'ghost' not found");
    expect(() => assignMember("kob", "frontend", "x")).toThrow("department 'frontend' not found");
  });

  test("remove drops the member and clears lead pointer", () => {
    assignMember("kob", "payment", "boss", "lead");
    removeMember("kob", "payment", "boss");
    expect(departmentMembers("kob", "payment")).toEqual([]);
    expect(loadCompany("kob")!.teams.payment.lead).toBeUndefined();
  });

  test("remove rejects non-members", () => {
    expect(() => removeMember("kob", "payment", "nobody")).toThrow("not a member");
  });

  test("members rejects unknown department", () => {
    expect(() => departmentMembers("kob", "frontend")).toThrow("not found");
  });
});

describe("naming guard", () => {
  beforeEach(() => {
    createCompany("kob");
    addDepartment("kob", "payment");
  });

  test("no collision for a fresh name + suggests structured convention", () => {
    const g = checkNamingCollision("kob", "payment", "fresh", "dev");
    expect(g.collision).toBe(false);
    expect(g.suggestion).toBe("kob-payment-dev");
  });

  test("collision detected when the oracle is already a department member", () => {
    assignMember("kob", "payment", "dupe", "dev");
    const g = checkNamingCollision("kob", "payment", "dupe", "qa");
    expect(g.collision).toBe(true);
    expect(g.suggestion).toBe("kob-payment-qa");
  });

  test("assign surfaces the collision flag on re-assign", () => {
    assignMember("kob", "payment", "dupe", "dev");
    const res = assignMember("kob", "payment", "dupe", "dev");
    expect(res.naming.collision).toBe(true);
    expect(res.naming.suggestion).toBe("kob-payment-dev");
  });

  test("checkNamingCollision is safe for unknown company/department", () => {
    expect(checkNamingCollision("ghost", "x", "y").collision).toBe(false);
  });
});

describe("validation + persistence shape", () => {
  test("assertValidName guards both kinds", () => {
    expect(() => assertValidName("company", "ok-name")).not.toThrow();
    expect(() => assertValidName("department", "9bad")).toThrow("invalid department name");
  });

  test("registry file is human-readable JSON with a trailing newline", () => {
    createCompany("kob");
    addDepartment("kob", "payment", { lead: "lead-1" });
    const raw = readFileSync(companyPath("kob"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(raw);
    // kobo-363: fresh writes use the `teams` key; kbTag no longer persisted.
    expect(parsed.teams.payment.lead).toBe("lead-1");
    expect(parsed.teams.payment.kbTag).toBeUndefined();
  });
});
