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
  companyPath,
  createCompany,
  addDepartment,
  addTeam,
  removeTeam,
} from "../../src/vendor/mpr-plugins/company/company-helpers";
import { writeFileSync } from "node:fs";

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

  // kobo-358: `maw company crew spawn <co>` — deterministic idempotent crew-cell
  // spawn, same delegation pattern as home/worklog/task above.
  test("company dispatches `crew` to its plugin's shared runner (kobo-358)", () => {
    const indexSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/company/index.ts"),
      "utf8",
    );
    expect(indexSrc).toContain('from "../crew/index"');
    expect(indexSrc).toContain("runCrew");
    expect(indexSrc).toContain('=== "crew"');
    expect(indexSrc).toContain("|crew|"); // usage string mentions the new verb
  });

  // kobo-364: `maw company head spawn <co>` — deterministic idempotent head-cell
  // spawn, same delegation pattern as crew above (mirrors 358's shape exactly).
  test("company dispatches `head` to its plugin's shared runner (kobo-364)", () => {
    const indexSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/company/index.ts"),
      "utf8",
    );
    expect(indexSrc).toContain('from "../head/index"');
    expect(indexSrc).toContain("runHead");
    expect(indexSrc).toContain('=== "head"');
    expect(indexSrc).toContain("|head|"); // usage string mentions the new verb
  });

  // kobo-362: `maw company up/down <co>` — fleet wake+teardown for a whole
  // company, same sibling-plugin delegation pattern as crew above.
  test("company dispatches `up`/`down` to company-fleet (kobo-362)", () => {
    const indexSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/company/index.ts"),
      "utf8",
    );
    expect(indexSrc).toContain('from "./company-fleet"');
    expect(indexSrc).toContain("runCompanyUp");
    expect(indexSrc).toContain("runCompanyDown");
    expect(indexSrc).toContain('=== "up"');
    expect(indexSrc).toContain('=== "down"');
    expect(indexSrc).toContain("|up|down|"); // usage string mentions the new verbs
  });

  // kobo-362/366: pin the design-blessed contract on the fleet module itself —
  // 2-tier up (session-tier cmdWake cold-start, cell-tier repair-via-injection)
  // applied SYMMETRICALLY to manager (head spawn, kobo-366 — closed the moment
  // kobo-364 shipped the verb) and crew-front (crew spawn) alike. down reuses
  // kobo-358's teardownCrewWindows + refuse-if-busy/--force.
  test("company-fleet: 2-tier up (manager+crew symmetric) + down reuses 358 teardown + busy-gate", () => {
    const fleetSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/company/company-fleet.ts"),
      "utf8",
    );
    expect(fleetSrc).toContain('from "../crew/teardown"'); // reuses kobo-358 AS-IS, doesn't re-port it
    expect(fleetSrc).toContain("cmdWake"); // session-tier cold-start (empirically verified, eq3 2-tier ruling)
    expect(fleetSrc).toContain("maw company head spawn"); // kobo-366: manager repairs via the head-spawn verb
    expect(fleetSrc).toContain("maw company crew spawn"); // crew-front repairs via the crew-spawn verb
    expect(fleetSrc).toContain("checkBusyGuard"); // down's refuse-if-busy default
    expect(fleetSrc).toContain("opts.force"); // --force override
    expect(fleetSrc).toContain("invokerPane"); // global-invoker protection (never kill the calling pane)
    // no silent core-lead fallback when a company has no manager — a dept lead ≠ company head
    expect(fleetSrc).toContain("no company head");
  });

  // kobo-363: departments → teams vocab rename. add-team/rm-team are canonical;
  // add-dept/rm-dept kept as aliases (same underlying logic) during migration.
  test("company keeps add-dept/rm-dept as aliases of add-team/rm-team (kobo-363)", () => {
    const indexSrc = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/company/index.ts"),
      "utf8",
    );
    expect(indexSrc).toContain('sub === "add-dept" || sub === "add-team"');
    expect(indexSrc).toContain('sub === "rm-dept" || sub === "rm-team"');
    expect(indexSrc).toContain("|add-team|add-dept|");
    expect(indexSrc).toContain("|rm-team|rm-dept|");
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
        teams: {
          core: { lead: "nai", members: [{ oracle: "nai", role: "lead" }] },
        },
      });
      const loaded = loadCompany("pgw")!;
      expect(loaded.manager).toBe("thawanban");
      // the manager is the tier above — must NOT be smuggled into a dept roster
      const inRoster = Object.values(loaded.teams).some(d => d.members.some(m => m.oracle === "thawanban"));
      expect(inRoster).toBe(false);
    });

    test("a company with no manager loads cleanly (field is optional)", () => {
      saveCompany({ name: "acme", teams: {} });
      expect(loadCompany("acme")!.manager).toBeUndefined();
    });

    // kobo-258 — the company lead (default room partner / reviewer): manager wins,
    // else the `core` dept lead, else any dept lead, else null.
    test("companyLead: manager > core dept lead > any dept lead > null", () => {
      saveCompany({ name: "pgw", manager: "thawanban", teams: { core: { lead: "nai", members: [] } } });
      expect(companyLead("pgw")).toBe("thawanban"); // manager wins
      saveCompany({ name: "kobo", teams: { core: { lead: "eq3", members: [] }, utils: { lead: "pm1", members: [] } } });
      expect(companyLead("kobo")).toBe("eq3"); // no manager → core dept lead
      saveCompany({ name: "solo", teams: { ops: { lead: "zed", members: [] } } });
      expect(companyLead("solo")).toBe("zed"); // no core → any dept lead
      saveCompany({ name: "empty", teams: {} });
      expect(companyLead("empty")).toBeNull(); // no lead anywhere
      expect(companyLead("nonexistent")).toBeNull(); // unknown company
    });

    // kobo-260 — the Rule-6 verify set: manager + every dept lead + every dept member.
    test("companyOracles = manager ∪ dept leads ∪ dept members (Rule-6 verify set)", () => {
      saveCompany({ name: "pgw", manager: "thawanban", teams: {
        core: { lead: "nai", members: [{ oracle: "nai", role: "lead" }, { oracle: "dev1", role: "dev" }] },
        driver: { lead: "sapan", members: [{ oracle: "sapan", role: "lead" }] },
      } });
      const set = companyOracles("pgw");
      expect([...set].sort()).toEqual(["dev1", "nai", "sapan", "thawanban"]); // manager + leads + members, deduped
      expect(companyOracles("nonexistent").size).toBe(0); // unknown company → empty
    });
  });

  // kobo-363: departments → teams rename, dual-read backward-compat, kbTag drop.
  describe("departments → teams dual-read backward-compat (kobo-363)", () => {
    const ORIGINAL_DIR = COMPANIES_DIR;
    let tmp: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "company-teams-standalone-"));
      _setCompaniesDir(tmp);
    });
    afterEach(() => {
      _setCompaniesDir(ORIGINAL_DIR);
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    test("a legacy config with the OLD `departments` key still loads correctly", () => {
      writeFileSync(companyPath("legacy"), JSON.stringify({
        name: "legacy",
        departments: { core: { lead: "nai", members: [{ oracle: "nai", role: "lead" }] } },
      }));
      const c = loadCompany("legacy")!;
      expect(c.teams.core.lead).toBe("nai");
      expect(c.teams.core.members).toEqual([{ oracle: "nai", role: "lead" }]);
    });

    test("a fresh write uses the `teams` key (not `departments`)", () => {
      createCompany("fresh");
      addDepartment("fresh", "core");
      const raw = JSON.parse(readFileSync(companyPath("fresh"), "utf8"));
      expect(raw.teams).toBeDefined();
      expect(raw.departments).toBeUndefined();
    });

    test("a config with BOTH `teams` and `departments` prefers `teams`, doesn't throw", () => {
      writeFileSync(companyPath("ambiguous"), JSON.stringify({
        name: "ambiguous",
        teams: { core: { lead: "new-lead", members: [] } },
        departments: { core: { lead: "old-lead", members: [] } },
      }));
      const c = loadCompany("ambiguous")!;
      expect(c.teams.core.lead).toBe("new-lead"); // teams wins over legacy departments
    });

    test("addTeam/removeTeam are aliases of addDepartment/removeDepartment (same logic)", () => {
      expect(addTeam).toBe(addDepartment);
      createCompany("aliastest");
      addTeam("aliastest", "core");
      expect(loadCompany("aliastest")!.teams.core).toBeDefined();
      removeTeam("aliastest", "core");
      expect(loadCompany("aliastest")!.teams.core).toBeUndefined();
    });

    test("kbTag is not persisted on a fresh department/team", () => {
      createCompany("nokbtag");
      addDepartment("nokbtag", "core");
      const raw = JSON.parse(readFileSync(companyPath("nokbtag"), "utf8"));
      expect(raw.teams.core.kbTag).toBeUndefined();
    });
  });
});
