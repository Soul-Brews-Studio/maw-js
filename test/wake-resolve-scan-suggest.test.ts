/**
 * Tests for wake-resolve-scan-suggest: the interactive org-scan flow that runs
 * when maw wake can't find an oracle via ghq, fleet, worktrees, or silent clone.
 *
 * All tests use injected deps — no real gh/ghq calls, no /dev/tty access.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  extractGhqOrgs,
  buildOrgList,
  scanOrgs,
  scanSuggestOracle,
  readTtyAnswer,
  fetchAllowedOrgs,
  filterOrgsByAllowed,
  _resetAllowedOrgsCache,
  type OrgEntry,
  type TtyReader,
} from "../src/commands/shared/wake-resolve-scan-suggest";

// #770 — every test that exercises the org-scope filter must start from a
// clean cache; otherwise a prior test's mocked execFn leaks across cases.
beforeEach(() => { _resetAllowedOrgsCache(); });

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

  test("leftover newline from prior inquirer prompt does not cause false abort", async () => {
    // Repro of oracle-world bug: inquirer leaves '\n' on /dev/tty; our first
    // readSync picks it up, trims to "", returns false → user sees "aborted"
    // despite typing 'y'. The fix: loop past whitespace-only reads.
    const reads: ReturnType<TtyReader>[] = [
      { ok: true, text: "\n", n: 1 },      // leftover newline from prior prompt
      { ok: true, text: "y\n", n: 2 },     // actual user answer
    ];
    let i = 0;
    const reader: TtyReader = () => reads[i++] ?? { ok: false };

    const answer = readTtyAnswer(reader);
    expect(answer).toBe("y");
    expect(i).toBe(2); // both reads consumed
  });

  test("readTtyAnswer returns null after 3 whitespace-only reads", () => {
    const reader: TtyReader = () => ({ ok: true, text: "\n", n: 1 });
    expect(readTtyAnswer(reader)).toBeNull();
  });

  test("readTtyAnswer returns null when TTY unavailable", () => {
    const reader: TtyReader = () => ({ ok: false });
    expect(readTtyAnswer(reader)).toBeNull();
  });

  test("readTtyAnswer returns null on EOF (n=0)", () => {
    const reader: TtyReader = () => ({ ok: true, text: "", n: 0 });
    expect(readTtyAnswer(reader)).toBeNull();
  });

  test("readTtyAnswer lowercases and trims the answer", () => {
    const reader: TtyReader = () => ({ ok: true, text: "  YES  \n", n: 8 });
    expect(readTtyAnswer(reader)).toBe("yes");
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

// ---------------------------------------------------------------------------
// #770 — owned/member org scope filter
// ---------------------------------------------------------------------------

describe("fetchAllowedOrgs (#770)", () => {
  test("returns user + orgs when both api calls succeed", () => {
    const execFn = (cmd: string): string => {
      if (cmd.startsWith("gh api user --jq .login")) return "nazt\n";
      if (cmd.startsWith("gh api user/orgs")) return "Soul-Brews-Studio\nlaris-co\n";
      throw new Error(`unexpected: ${cmd}`);
    };
    const result = fetchAllowedOrgs(execFn);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user).toBe("nazt");
    expect([...result.orgs].sort()).toEqual(["Soul-Brews-Studio", "laris-co", "nazt"].sort());
  });

  test("falls back to ok:false when gh api user fails (unauthenticated)", () => {
    const execFn = (cmd: string): string => {
      if (cmd.startsWith("gh api user --jq")) throw new Error("401 Bad credentials");
      return "";
    };
    const result = fetchAllowedOrgs(execFn);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("gh api user failed");
  });

  test("returns just the user when user/orgs fails (e.g. token lacks read:org)", () => {
    const execFn = (cmd: string): string => {
      if (cmd.startsWith("gh api user --jq")) return "nazt\n";
      if (cmd.startsWith("gh api user/orgs")) throw new Error("403 Resource not accessible");
      throw new Error(`unexpected: ${cmd}`);
    };
    const result = fetchAllowedOrgs(execFn);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.orgs]).toEqual(["nazt"]);
  });

  test("caches across calls — second invocation does not hit execFn", () => {
    let calls = 0;
    const execFn = (cmd: string): string => {
      calls++;
      if (cmd.startsWith("gh api user --jq")) return "nazt\n";
      if (cmd.startsWith("gh api user/orgs")) return "Soul-Brews-Studio\n";
      throw new Error(`unexpected: ${cmd}`);
    };
    fetchAllowedOrgs(execFn);
    const callsAfterFirst = calls;
    fetchAllowedOrgs(execFn);
    expect(calls).toBe(callsAfterFirst);
  });
});

describe("filterOrgsByAllowed (#770)", () => {
  const ghqOrgs: OrgEntry[] = [
    { name: "anthropics", source: "local" },        // read-only upstream — out
    { name: "NousResearch", source: "local" },      // read-only upstream — out
    { name: "Soul-Brews-Studio", source: "local" }, // owned — in
    { name: "nazt", source: "local" },              // user — in
    { name: "laris-co", source: "local" },          // member — in
    { name: "arthur-oracle.wt", source: "local" },  // worktree artifact — out
  ];

  test("(a) read-only upstream orgs are filtered out", () => {
    const allowed = { ok: true as const, user: "nazt", orgs: new Set(["nazt", "Soul-Brews-Studio", "laris-co"]) };
    const filtered = filterOrgsByAllowed(ghqOrgs, allowed);
    const names = filtered.map(o => o.name);
    expect(names).not.toContain("anthropics");
    expect(names).not.toContain("NousResearch");
    expect(names).not.toContain("arthur-oracle.wt");
  });

  test("(b) owned org is included", () => {
    const allowed = { ok: true as const, user: "nazt", orgs: new Set(["nazt", "Soul-Brews-Studio"]) };
    const names = filterOrgsByAllowed(ghqOrgs, allowed).map(o => o.name);
    expect(names).toContain("Soul-Brews-Studio");
  });

  test("(c) member org is included", () => {
    const allowed = { ok: true as const, user: "nazt", orgs: new Set(["nazt", "laris-co"]) };
    const names = filterOrgsByAllowed(ghqOrgs, allowed).map(o => o.name);
    expect(names).toContain("laris-co");
  });

  test("(e) when allowed.ok is false, filter is a passthrough (graceful fallback)", () => {
    const allowed = { ok: false as const, reason: "gh api user failed: 401" };
    const result = filterOrgsByAllowed(ghqOrgs, allowed);
    expect(result).toEqual(ghqOrgs);
  });
});

describe("scanSuggestOracle scope filter (#770)", () => {
  test("(a-c) filters scan to owned + member orgs by default", async () => {
    const probed: string[] = [];
    const result = await scanSuggestOracle("liquid", {
      execFn: (cmd) => {
        if (cmd.includes("gh --version")) return "gh version 2.0.0";
        if (cmd.startsWith("ghq list") && !cmd.includes("--full-path")) {
          return [
            "github.com/anthropics/claude-code",       // upstream
            "github.com/NousResearch/some-tool",       // upstream
            "github.com/Soul-Brews-Studio/maw-js",     // owned
            "github.com/nazt/dotfiles",                // user
            "github.com/laris-co/neo-oracle",          // member
          ].join("\n");
        }
        if (cmd.startsWith("gh api user --jq")) return "nazt\n";
        if (cmd.startsWith("gh api user/orgs")) return "Soul-Brews-Studio\nlaris-co\n";
        if (cmd.startsWith("gh repo view ")) {
          const m = cmd.match(/gh repo view '([^']+)'/);
          if (m) probed.push(m[1]!);
          throw new Error("not found");
        }
        throw new Error(`unexpected: ${cmd}`);
      },
      promptFn: () => true,
      configFn: () => ({}),
      hostExecFn: async () => "",
    });

    expect(result).toBeNull();
    // Read-only upstream orgs must NOT be probed
    expect(probed).not.toContain("anthropics/liquid-oracle");
    expect(probed).not.toContain("NousResearch/liquid-oracle");
    // Allowed orgs MUST be probed
    expect(probed).toContain("Soul-Brews-Studio/liquid-oracle");
    expect(probed).toContain("nazt/liquid-oracle");
    expect(probed).toContain("laris-co/liquid-oracle");
    expect(probed.length).toBe(3);
  });

  test("(d) --all-local bypasses filter and scans every org", async () => {
    const probed: string[] = [];
    const result = await scanSuggestOracle("liquid", {
      execFn: (cmd) => {
        if (cmd.includes("gh --version")) return "gh version 2.0.0";
        if (cmd.startsWith("ghq list") && !cmd.includes("--full-path")) {
          return [
            "github.com/anthropics/claude-code",
            "github.com/Soul-Brews-Studio/maw-js",
          ].join("\n");
        }
        if (cmd.startsWith("gh api")) {
          throw new Error("gh api MUST NOT be called when --all-local is set");
        }
        if (cmd.startsWith("gh repo view ")) {
          const m = cmd.match(/gh repo view '([^']+)'/);
          if (m) probed.push(m[1]!);
          throw new Error("not found");
        }
        throw new Error(`unexpected: ${cmd}`);
      },
      promptFn: () => true,
      configFn: () => ({}),
      hostExecFn: async () => "",
      allLocal: true,
    });

    expect(result).toBeNull();
    expect(probed).toContain("anthropics/liquid-oracle");
    expect(probed).toContain("Soul-Brews-Studio/liquid-oracle");
  });

  test("(e) gh api user failure falls back to all-local with warning (does not abort)", async () => {
    const probed: string[] = [];
    const warnings: string[] = [];
    const origErr = console.error;
    console.error = (...a: any[]) => { warnings.push(a.map(String).join(" ")); };
    try {
      const result = await scanSuggestOracle("liquid", {
        execFn: (cmd) => {
          if (cmd.includes("gh --version")) return "gh version 2.0.0";
          if (cmd.startsWith("ghq list") && !cmd.includes("--full-path")) {
            return [
              "github.com/anthropics/claude-code",
              "github.com/Soul-Brews-Studio/maw-js",
            ].join("\n");
          }
          if (cmd.startsWith("gh api user --jq")) throw new Error("401 Bad credentials");
          if (cmd.startsWith("gh repo view ")) {
            const m = cmd.match(/gh repo view '([^']+)'/);
            if (m) probed.push(m[1]!);
            throw new Error("not found");
          }
          throw new Error(`unexpected: ${cmd}`);
        },
        promptFn: () => true,
        configFn: () => ({}),
        hostExecFn: async () => "",
      });
      expect(result).toBeNull();
      // Both orgs probed — fallback retains legacy behavior on api failure
      expect(probed).toContain("anthropics/liquid-oracle");
      expect(probed).toContain("Soul-Brews-Studio/liquid-oracle");
      // Warning surfaced so the user understands why the scope wasn't narrowed
      expect(warnings.some(w => w.includes("org-scope filter unavailable"))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });

  test("returns null with a hint when filter empties the org list", async () => {
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...a: any[]) => { errors.push(a.map(String).join(" ")); };
    try {
      const result = await scanSuggestOracle("liquid", {
        execFn: (cmd) => {
          if (cmd.includes("gh --version")) return "gh version 2.0.0";
          if (cmd.startsWith("ghq list") && !cmd.includes("--full-path")) {
            return "github.com/anthropics/claude-code\ngithub.com/NousResearch/some-tool\n";
          }
          if (cmd.startsWith("gh api user --jq")) return "nazt\n";
          if (cmd.startsWith("gh api user/orgs")) return "";
          throw new Error(`unexpected: ${cmd}`);
        },
        promptFn: () => true,
        configFn: () => ({}),
        hostExecFn: async () => "",
      });
      expect(result).toBeNull();
      expect(errors.some(e => e.includes("--all-local"))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });
});
