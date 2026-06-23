import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

// #2316 plugin-coverage-gate: the `company`/`dept` plugin is the org layer
// (registry, assign, attach, dept knowledge) plus the company/dept POLICY
// surface (sync snapshot, migrate sweep, attach/detach). It shells two core
// services on purpose — the policy attach-store (server-readable attach marker)
// and the shared fuzzy matcher — so this test pins exactly which boundaries the
// plugin may cross, making extraction drift visible instead of silent.

describe("company command plugin standalone boundary", () => {
  test("company keeps explicit import boundaries (SDK + core/policy attach-store + core/util fuzzy)", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "company",
      allowRelative: [
        /^(?:\.\.\/){3}core\/policy\//, // attach-store — policy inject gate
        /^(?:\.\.\/){3}core\/util\//,   // fuzzy matcher for attach resolution
      ],
    }).map((record) => record.spec);

    expect(imports).toContain("maw-js/sdk");
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
});
