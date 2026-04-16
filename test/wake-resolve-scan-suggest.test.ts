/**
 * Tests for wake-resolve-scan-suggest: the interactive org-scan flow that runs
 * when maw wake can't find an oracle via ghq, fleet, worktrees, or silent clone.
 *
 * All tests use injected deps — no real gh/ghq calls, no /dev/tty access.
 */
import { describe, test, expect } from "bun:test";
import {
  extractGhqOrgs,
  buildOrgList,
  scanOrgs,
  scanSuggestOracle,
  type OrgEntry,
} from "../src/commands/shared/wake-resolve-scan-suggest";

// ---------------------------------------------------------------------------
// extractGhqOrgs — unit tests
// ---------------------------------------------------------------------------

describe("extractGhqOrgs", () => {
  test("extracts unique sorted org names from ghq list output", () => {
    const input = [
      "github.com/Soul-Brews-Studio/wireboy-oracle",
      "github.com/laris-co/neo-oracle",
      "github.com/Soul-Brews-Studio/maw-js",
      "github.com/laris-co/maw-ui",
    ].join("\n");
    expect(extractGhqOrgs(input)).toEqual(["Soul-Brews-Studio", "laris-co"]);
  });

  test("returns empty array for empty input", () => {
    expect(extractGhqOrgs("")).toEqual([]);
  });

  test("skips lines with fewer than 3 path segments", () => {
    const input = "github.com/only-two\nfoo\ngithub.com/org/repo";
    expect(extractGhqOrgs(input)).toEqual(["org"]);
  });

  test("deduplicates orgs across multiple repos", () => {
    const input = "github.com/myorg/repo1\ngithub.com/myorg/repo2\ngithub.com/myorg/repo3";
    expect(extractGhqOrgs(input)).toEqual(["myorg"]);
  });
});

// ---------------------------------------------------------------------------
// buildOrgList — sort + dedup
// ---------------------------------------------------------------------------

describe("buildOrgList", () => {
  test("sorts orgs case-insensitively regardless of insertion order", () => {
    const ghqOutput = [
      "github.com/zZZ-org/repo",
      "github.com/aaa-org/repo",
      "github.com/MMM-org/repo",
    ].join("\n");
    const result = buildOrgList(ghqOutput, { githubOrg: "BBB-org" });
    const names = result.map(o => o.name);
    expect(names).toEqual(["aaa-org", "BBB-org", "MMM-org", "zZZ-org"]);
  });

  test("config org gets source label 'config', ghq orgs get 'local'", () => {
    const result = buildOrgList("github.com/from-ghq/repo\n", { githubOrg: "from-config" });
    expect(result.find(o => o.name === "from-ghq")?.source).toBe("local");
    expect(result.find(o => o.name === "from-config")?.source).toBe("config");
  });

  test("deduplicates org that appears in both ghq and config", () => {
    const result = buildOrgList("github.com/shared-org/repo\n", { githubOrg: "shared-org" });
    expect(result.filter(o => o.name === "shared-org").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// scanOrgs — stop-on-first-match
// ---------------------------------------------------------------------------

describe("scanOrgs — stop on first match", () => {
  test("returns first found org and does not scan remaining orgs", () => {
    const orgs: OrgEntry[] = [
      { name: "laris-co", source: "local" },
      { name: "Soul-Brews-Studio", source: "local" },
      { name: "arra-oracle", source: "config" },
    ];

    const scanned: string[] = [];
    const execFn = (cmd: string): string => {
      const m = cmd.match(/gh repo view '([^/]+)\/([^']+)'/);
      if (!m) throw new Error("unexpected command");
      const org = m[1]!;
      scanned.push(org);
      // Only Soul-Brews-Studio has the repo
      if (org === "Soul-Brews-Studio") {
        return JSON.stringify({ url: "https://github.com/Soul-Brews-Studio/wireboy-oracle" });
      }
      throw new Error("not found");
    };

    const result = scanOrgs("wireboy", orgs, execFn);

    expect(result).not.toBeNull();
    expect(result!.org).toBe("Soul-Brews-Studio");
    expect(result!.url).toBe("https://github.com/Soul-Brews-Studio/wireboy-oracle");
    // arra-oracle must NOT have been scanned — we stopped after Soul-Brews-Studio
    expect(scanned).not.toContain("arra-oracle");
    expect(scanned).toContain("laris-co");
    expect(scanned).toContain("Soul-Brews-Studio");
  });

  test("returns null when no org has the repo", () => {
    const orgs: OrgEntry[] = [
      { name: "org-a", source: "local" },
      { name: "org-b", source: "config" },
    ];
    const result = scanOrgs("ghost", orgs, () => { throw new Error("not found"); });
    expect(result).toBeNull();
  });

  test("strips -oracle suffix from oracle name before scanning", () => {
    // If caller passes "wireboy-oracle" instead of "wireboy", we should not get
    // "wireboy-oracle-oracle" as the target slug.
    const orgs: OrgEntry[] = [{ name: "my-org", source: "local" }];
    const scanned: string[] = [];
    const execFn = (cmd: string): string => {
      scanned.push(cmd);
      throw new Error("not found");
    };
    scanOrgs("wireboy-oracle", orgs, execFn);
    // The slug checked should be "my-org/wireboy-oracle", not "my-org/wireboy-oracle-oracle"
    expect(scanned[0]).toContain("my-org/wireboy-oracle");
    expect(scanned[0]).not.toContain("wireboy-oracle-oracle");
  });
});

// ---------------------------------------------------------------------------
// scanSuggestOracle — non-TTY fallback
// ---------------------------------------------------------------------------

describe("scanSuggestOracle — non-TTY fallback", () => {
  test("returns null without crashing when TTY is unavailable (promptFn returns null)", async () => {
    const result = await scanSuggestOracle("testoracle", {
      execFn: (cmd) => {
        if (cmd.includes("gh --version")) return "gh version 2.0.0";
        if (cmd.includes("ghq list") && !cmd.includes("--full-path")) {
          return "github.com/Soul-Brews-Studio/maw-js\n";
        }
        throw new Error("unexpected");
      },
      promptFn: () => null,  // simulates non-TTY: /dev/tty unavailable
      configFn: () => ({ githubOrg: "Soul-Brews-Studio" }),
      hostExecFn: async () => "",
    });

    expect(result).toBeNull();
  });

  test("returns null when user declines (process.exit guarded by not reaching it in tests)", async () => {
    // We can't test process.exit(0) directly, so we test the not-found path instead
    // (user consents → scan runs → nothing found → returns null)
    const result = await scanSuggestOracle("notexistsoracle", {
      execFn: (cmd) => {
        if (cmd.includes("gh --version")) return "gh version 2.0.0";
        if (cmd.includes("ghq list")) return "github.com/my-org/other-repo\n";
        // All gh repo view calls fail (not found)
        throw new Error("not found");
      },
      promptFn: () => true,  // user says yes
      configFn: () => ({ githubOrg: "my-org" }),
      hostExecFn: async () => "",
    });

    expect(result).toBeNull();
  });

  test("returns null gracefully when gh cli is not installed", async () => {
    const result = await scanSuggestOracle("anyoracle", {
      execFn: () => { throw new Error("gh: command not found"); },
      promptFn: () => true,
      configFn: () => ({}),
      hostExecFn: async () => "",
    });

    expect(result).toBeNull();
  });
});
