/**
 * Tests for src/commands/shared/wake-resolve-scan-suggest.ts — extractGhqOrgs, buildOrgList.
 * Pure functions, no I/O.
 */
import { describe, it, expect } from "bun:test";
import { extractGhqOrgs, buildOrgList } from "../../src/commands/shared/wake-resolve-scan-suggest";

describe("extractGhqOrgs", () => {
  it("extracts org names from ghq list output", () => {
    const output = [
      "github.com/Soul-Brews-Studio/maw-js",
      "github.com/Soul-Brews-Studio/oracle-cli",
      "github.com/kanawutc/home-scraper",
    ].join("\n");
    const orgs = extractGhqOrgs(output);
    expect(orgs).toContain("Soul-Brews-Studio");
    expect(orgs).toContain("kanawutc");
  });

  it("deduplicates orgs", () => {
    const output = [
      "github.com/myorg/repo1",
      "github.com/myorg/repo2",
    ].join("\n");
    const orgs = extractGhqOrgs(output);
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toBe("myorg");
  });

  it("returns sorted output", () => {
    const output = "github.com/z-org/r\ngithub.com/a-org/r";
    const orgs = extractGhqOrgs(output);
    expect(orgs).toEqual(["a-org", "z-org"]);
  });

  it("returns empty for empty input", () => {
    expect(extractGhqOrgs("")).toEqual([]);
  });

  it("skips lines with fewer than 3 parts", () => {
    expect(extractGhqOrgs("github.com/onlyhost")).toEqual([]);
  });
});

describe("buildOrgList", () => {
  it("combines ghq orgs and config orgs", () => {
    const ghq = "github.com/myorg/repo";
    const cfg = { githubOrg: "config-org" };
    const result = buildOrgList(ghq, cfg);
    expect(result.find(e => e.name === "myorg")).toBeDefined();
    expect(result.find(e => e.name === "config-org")).toBeDefined();
  });

  it("deduplicates config org if already in ghq", () => {
    const ghq = "github.com/myorg/repo";
    const cfg = { githubOrg: "myorg" };
    const result = buildOrgList(ghq, cfg);
    const matches = result.filter(e => e.name === "myorg");
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe("local");
  });

  it("supports githubOrgs array", () => {
    const cfg = { githubOrgs: ["org1", "org2"] };
    const result = buildOrgList("", cfg);
    expect(result).toHaveLength(2);
  });

  it("sorts case-insensitively", () => {
    const ghq = "github.com/Zebra/r\ngithub.com/alpha/r";
    const result = buildOrgList(ghq, {});
    expect(result[0].name).toBe("alpha");
    expect(result[1].name).toBe("Zebra");
  });

  it("returns empty for empty input and no config", () => {
    expect(buildOrgList("", {})).toEqual([]);
  });
});
