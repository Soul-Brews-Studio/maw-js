import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";
import {
  COMPANIES_DIR,
  _setCompaniesDir,
  companyLead,
  companyOracles,
  loadCompany,
  saveCompany,
} from "../../src/vendor/mpr-plugins/company/company-helpers";

// #2316 plugin-coverage-gate: the `company`/`dept` plugin is the org layer
// (registry, assign, attach, dept knowledge) plus the company/dept POLICY
// surface (sync snapshot, migrate sweep, attach/detach). It shells two core
// services on purpose — the policy attach-store (server-readable attach marker)
// and the shared fuzzy matcher — so this test pins exactly which boundaries the
// plugin may cross, making extraction drift visible instead of silent.

describe("company command plugin standalone boundary", () => {
  test("company keeps explicit import boundaries (SDK + core/policy + core/util + core/worklog)", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "company",
      allowRelative: [
        /^(?:\.\.\/){3}core\/policy\//,  // attach-store — policy inject gate
        /^(?:\.\.\/){3}core\/util\//,    // fuzzy matcher for attach resolution
        /^(?:\.\.\/){3}core\/worklog\//, // hook-setup (provision) + company-scope (#2 re-home)
      ],
    }).map((record) => record.spec);

    expect(imports).toContain("maw-js/sdk");
  });

  test("assign auto-provisions hooks; remove prunes; `company hooks` re-homes setup (#2)", () => {
    const indexSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/company/index.ts"),
      "utf8",
    );
    expect(indexSrc).toContain("provisionOracleHooks"); // assign + attach auto-provision
    expect(indexSrc).toContain("pruneOracleHooks");     // remove prunes
    expect(indexSrc).toContain('sub === "hooks"');      // re-homed status/repair/prune verb
  });

  // cli-reorg (ADR docs/company/0001): `maw company home|worklog|task` delegate to
  // their plugins' shared runners (one logic copy each). Sibling-plugin imports,
  // dispatched like the async `attach` verb.
  test("company dispatches `home`, `worklog` and `task` to their plugins' shared runners", () => {
    const indexSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/company/index.ts"),
      "utf8",
    );
    expect(indexSrc).toContain('from "../home/index"'); // sibling-plugin delegation
    expect(indexSrc).toContain("runHome");
    expect(indexSrc).toContain('=== "home"');
    expect(indexSrc).toContain('from "../watch/index"');
    expect(indexSrc).toContain("runWorklog");
    expect(indexSrc).toContain('=== "worklog"');
    expect(indexSrc).toContain('from "../task/index"');
    expect(indexSrc).toContain("runTask");
    expect(indexSrc).toContain('=== "task"');
  });

  test("attach marks the attach gate; detach clears it (policy inject pairs with attach)", () => {
    const attachSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/company/company-attach.ts"),
      "utf8",
    );
    // Attaching (and budding) an oracle must arm the server-readable marker so
    // its UserPromptSubmit policy hook starts injecting while attached.
    expect(attachSrc).toContain("setPolicyAttach");

    const indexSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/company/index.ts"),
      "utf8",
    );
    // The CLI surface wires the policy verbs: sync (snapshot), migrate (#19
    // sweep), detach (clear the gate).
    expect(indexSrc).toContain("syncCompanyPolicy");
    expect(indexSrc).toContain("migrateCompanyPolicy");
    expect(indexSrc).toContain("clearPolicyAttach");
  });

  test("assign no longer writes a static dept block (#19 — identity is inject-on-attach)", () => {
    const helpersSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/company/company-helpers.ts"),
      "utf8",
    );
    // syncOracleAssignment must not call writeDeptBlock anymore — dept identity
    // moved to the on-attach policy inject. (removeDeptBlockFromRepo stays, used
    // by clearOracleAssignment + the migrate sweep.)
    expect(helpersSrc).not.toContain("writeDeptBlock");
  });

  // eq3-014: the company-level manager/PM tier (a slot ABOVE the depts) must
  // survive the save/load round-trip so company-scope can resolve it. Pinned
  // here because it's the vendor-side half of the worklog manager-resolution fix.
  describe("company manager tier round-trips through the registry (eq3-014)", () => {
    const ORIGINAL_DIR = COMPANIES_DIR;
    let tmp: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "company-standalone-"));
      _setCompaniesDir(tmp);
    });
    afterEach(() => {
      _setCompaniesDir(ORIGINAL_DIR);
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    test("saveCompany persists `manager` and loadCompany returns it (not a dept member)", () => {
      saveCompany({
        name: "pgw",
        manager: "thawanban",
        departments: {
          core: { kbTag: "dept:pgw:core", lead: "nai", members: [{ oracle: "nai", role: "lead" }] },
        },
      });
      const loaded = loadCompany("pgw")!;
      expect(loaded.manager).toBe("thawanban");
      // the manager is the tier above — must NOT be smuggled into a dept roster
      const inRoster = Object.values(loaded.departments).some(d => d.members.some(m => m.oracle === "thawanban"));
      expect(inRoster).toBe(false);
    });

    test("a company with no manager loads cleanly (field is optional)", () => {
      saveCompany({ name: "acme", departments: {} });
      expect(loadCompany("acme")!.manager).toBeUndefined();
    });

    // kobo-258 — the company lead (default room partner / reviewer): manager wins,
    // else the `core` dept lead, else any dept lead, else null.
    test("companyLead: manager > core dept lead > any dept lead > null", () => {
      saveCompany({ name: "pgw", manager: "thawanban", departments: { core: { kbTag: "k", lead: "nai", members: [] } } });
      expect(companyLead("pgw")).toBe("thawanban"); // manager wins
      saveCompany({ name: "kobo", departments: { core: { kbTag: "k", lead: "eq3", members: [] }, utils: { kbTag: "k", lead: "pm1", members: [] } } });
      expect(companyLead("kobo")).toBe("eq3"); // no manager → core dept lead
      saveCompany({ name: "solo", departments: { ops: { kbTag: "k", lead: "zed", members: [] } } });
      expect(companyLead("solo")).toBe("zed"); // no core → any dept lead
      saveCompany({ name: "empty", departments: {} });
      expect(companyLead("empty")).toBeNull(); // no lead anywhere
      expect(companyLead("nonexistent")).toBeNull(); // unknown company
    });

    // kobo-260 — the Rule-6 verify set: manager + every dept lead + every dept member.
    test("companyOracles = manager ∪ dept leads ∪ dept members (Rule-6 verify set)", () => {
      saveCompany({ name: "pgw", manager: "thawanban", departments: {
        core: { kbTag: "k", lead: "nai", members: [{ oracle: "nai", role: "lead" }, { oracle: "dev1", role: "dev" }] },
        driver: { kbTag: "k", lead: "sapan", members: [{ oracle: "sapan", role: "lead" }] },
      } });
      const set = companyOracles("pgw");
      expect([...set].sort()).toEqual(["dev1", "nai", "sapan", "thawanban"]); // manager + leads + members, deduped
      expect(companyOracles("nonexistent").size).toBe(0); // unknown company → empty
    });
  });
});
