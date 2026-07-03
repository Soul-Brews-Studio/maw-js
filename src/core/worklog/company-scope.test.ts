/**
 * company-scope — the worklog boundary resolver. Two eq3-014 guarantees pinned
 * here: (1) a company-level manager/PM resolves to the company (not _unscoped)
 * without being a dept member, and (2) a miss is never memoized, so a transient
 * config-load hiccup can't blind an oracle permanently.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  COMPANIES_DIR,
  _setCompaniesDir,
  saveCompany,
  type Company,
} from "../../vendor/mpr-plugins/company/company-helpers";
import { scopeOfOracle, companyOfOracle, companyRoster, _clearScopeCache } from "./company-scope";
import { handleRosterRequest } from "../roster/route";

const ORIGINAL_DIR = COMPANIES_DIR;
let tmp: string;

const pgw = (): Company => ({
  name: "pgw",
  manager: "thawanban",
  departments: {
    core: { kbTag: "dept:pgw:core", lead: "nai", members: [{ oracle: "nai", role: "lead" }, { oracle: "lek", role: "dev" }] },
  },
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "company-scope-test-"));
  _setCompaniesDir(tmp);
  _clearScopeCache();
});

afterEach(() => {
  _setCompaniesDir(ORIGINAL_DIR);
  _clearScopeCache();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("company-scope resolution", () => {
  it("resolves a dept member to company/dept/lead", () => {
    saveCompany(pgw());
    expect(scopeOfOracle("lek")).toEqual({ company: "pgw", dept: "core", lead: "nai" });
    expect(companyOfOracle("nai")).toBe("pgw");
  });

  it("resolves a company-level manager to the company (dept null), not a dept member", () => {
    saveCompany(pgw());
    // thawanban is the PM above the depts — must map to pgw, not _unscoped.
    expect(companyOfOracle("thawanban")).toBe("pgw");
    expect(scopeOfOracle("thawanban")).toEqual({ company: "pgw", dept: null, lead: null });
    // …and is NOT smuggled into any dept roster.
    const rosterHasManager = Object.values(pgw().departments).some(d => d.members.some(m => m.oracle === "thawanban"));
    expect(rosterHasManager).toBe(false);
  });

  it("returns null for an unknown oracle", () => {
    saveCompany(pgw());
    expect(companyOfOracle("stranger")).toBeNull();
  });
});

describe("companyRoster + /api/roster (kobo-50 — authoritative membership)", () => {
  it("returns the manager (dept null, role manager) + every dept member with dept+role", () => {
    saveCompany(pgw());
    const roster = companyRoster("pgw");
    expect(roster).toContainEqual({ oracle: "thawanban", dept: null, role: "manager" });
    expect(roster).toContainEqual({ oracle: "nai", dept: "core", role: "lead" });
    expect(roster).toContainEqual({ oracle: "lek", dept: "core", role: "dev" });
    expect(roster).toHaveLength(3); // no dupes, manager not smuggled into a dept
  });

  it("unknown company → empty roster (never throws)", () => {
    expect(companyRoster("nope")).toEqual([]);
  });

  it("handleRosterRequest serves the roster; no company → empty", async () => {
    saveCompany(pgw());
    const res = await handleRosterRequest(new Request("http://x/api/roster?company=pgw"));
    const json = (await res.json()) as { company: string; roster: Array<{ oracle: string }> };
    expect(json.company).toBe("pgw");
    expect(json.roster.map((r) => r.oracle).sort()).toEqual(["lek", "nai", "thawanban"]);
    const none = (await handleRosterRequest(new Request("http://x/api/roster")).json()) as { roster: unknown[] };
    expect(none.roster).toEqual([]);
  });
});

describe("company-scope caching (eq3-014 retry-on-miss)", () => {
  it("does NOT memoize a miss — a later config load resolves on retry", () => {
    // Simulate the transient hiccup: registry not yet readable → miss.
    expect(companyOfOracle("thawanban")).toBeNull();
    // Config becomes available (server finished starting).
    saveCompany(pgw());
    // No _clearScopeCache — the retry must happen on its own, proving the miss
    // was never cached.
    expect(companyOfOracle("thawanban")).toBe("pgw");
  });

  it("memoizes a hit — stable within the run even if the registry then changes", () => {
    saveCompany(pgw());
    expect(companyOfOracle("lek")).toBe("pgw");
    // Registry wiped mid-run; the resolved hit stays cached (hooks fire often,
    // config rarely changes within a run).
    rmSync(join(tmp, "pgw.json"), { force: true });
    expect(companyOfOracle("lek")).toBe("pgw");
  });
});
