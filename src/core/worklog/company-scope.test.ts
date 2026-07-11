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
import { scopeOfOracle, companyOfOracle, companiesOfOracle, companyOfOracleStrict, companyRoster, companyOracles, _clearScopeCache } from "./company-scope";
import { companyOfOracleLight } from "./presence-away";
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

describe("companyOracles includes the manager (kobo-290)", () => {
  it("includes the manager alongside dept members when it is NOT itself a dept member", () => {
    saveCompany(pgw()); // manager thawanban is the PM above core (nai, lek)
    const oracles = companyOracles("pgw");
    expect(oracles).toContain("thawanban"); // the lead pane — was excluded before kobo-290
    expect([...oracles].sort()).toEqual(["lek", "nai", "thawanban"]);
  });

  it("dedups when the manager also appears as a dept member (provision once, not twice)", () => {
    // A company whose manager is ALSO listed inside a dept — must surface exactly once.
    saveCompany({
      name: "kobo",
      manager: "eq3",
      departments: {
        core: { kbTag: "dept:kobo:core", lead: "eq3", members: [{ oracle: "eq3", role: "lead" }, { oracle: "patchwork", role: "dev" }] },
      },
    });
    const oracles = companyOracles("kobo");
    expect(oracles.filter(o => o === "eq3")).toHaveLength(1); // no duplicate → wired once
    expect([...oracles].sort()).toEqual(["eq3", "patchwork"]);
  });

  it("returns [] for an unknown company", () => {
    expect(companyOracles("nonexistent")).toEqual([]);
  });
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

// kobo-216 (Card B of kobo-166) — a shared oracle across 2 companies. `zeta` sorts
// AFTER `pgw`, so name-sorted iteration deterministically first-matches `pgw`.
const zeta = (): Company => ({
  name: "zeta",
  departments: {
    core: { kbTag: "dept:zeta:core", lead: "lek", members: [{ oracle: "lek", role: "lead" }] },
  },
});

describe("companiesOfOracle + companyOfOracleStrict (kobo-216 option-a)", () => {
  it("companiesOfOracle lists EVERY company, name-sorted", () => {
    saveCompany(zeta());
    saveCompany(pgw());
    expect(companiesOfOracle("lek")).toEqual(["pgw", "zeta"]); // member of both, sorted
    expect(companiesOfOracle("nai")).toEqual(["pgw"]);         // single
    expect(companiesOfOracle("thawanban")).toEqual(["pgw"]);   // manager tier counts
    expect(companiesOfOracle("stranger")).toEqual([]);         // unknown → empty
  });

  it("strict: single-company oracle resolves unchanged (no --company needed)", () => {
    saveCompany(pgw());
    expect(companyOfOracleStrict("nai")).toBe("pgw");
    expect(companyOfOracleStrict("thawanban")).toBe("pgw");
  });

  it("strict: multi-company oracle + no explicit → THROWS loud (option-a, not silent)", () => {
    saveCompany(zeta());
    saveCompany(pgw());
    expect(() => companyOfOracleStrict("lek")).toThrow(/ambiguous: lek belongs to \[pgw, zeta\] — specify --company/);
  });

  it("strict: explicit --company wins even when ambiguous (no throw)", () => {
    saveCompany(zeta());
    saveCompany(pgw());
    expect(companyOfOracleStrict("lek", "zeta")).toBe("zeta");
  });

  it("strict: unknown oracle → null (caller falls back to config, unchanged)", () => {
    saveCompany(pgw());
    expect(companyOfOracleStrict("stranger")).toBeNull();
  });
});

// kobo-216 — the two twin resolvers must AGREE for a multi-company oracle. Point both
// at the same registry: companyOfOracle via _setCompaniesDir, companyOfOracleLight via
// mawDataPath("companies") (= MAW_DATA_DIR/companies). Before this fix Light's raw
// readdir order could first-match a different company than the name-sorted twin.
describe("twin resolver agreement (kobo-216)", () => {
  const ORIG_DATA = process.env.MAW_DATA_DIR;
  let dataTmp: string;
  beforeEach(() => {
    dataTmp = mkdtempSync(join(tmpdir(), "twin-data-"));
    process.env.MAW_DATA_DIR = dataTmp;
    const companies = join(dataTmp, "companies");
    _setCompaniesDir(companies); // companyOfOracle writes/reads here
    _clearScopeCache();
    saveCompany(zeta());
    saveCompany(pgw());
  });
  afterEach(() => {
    if (ORIG_DATA === undefined) delete process.env.MAW_DATA_DIR;
    else process.env.MAW_DATA_DIR = ORIG_DATA;
    _setCompaniesDir(ORIGINAL_DIR);
    _clearScopeCache();
    try { rmSync(dataTmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("companyOfOracle === companyOfOracleLight for a 2-company oracle (both name-first)", () => {
    expect(companyOfOracle("lek")).toBe("pgw");        // name-sorted first
    expect(companyOfOracleLight("lek")).toBe("pgw");   // sorted readdir → same
    expect(companyOfOracle("lek")).toBe(companyOfOracleLight("lek"));
  });

  it("both agree on a single-company oracle too", () => {
    expect(companyOfOracle("nai")).toBe(companyOfOracleLight("nai"));
    expect(companyOfOracleLight("nai")).toBe("pgw");
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
