/** Focused mock-only coverage for wake-resolve-scan-suggest branches. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetAllowedOrgsCache,
  fetchAllowedOrgs,
  filterOrgsByAllowed,
  readTtyAnswer,
  scanOrgs,
  scanSuggestOracle,
  type OrgEntry,
  type TtyReader,
} from "../../src/commands/shared/wake-resolve-scan-suggest";

type Allowed = Parameters<typeof filterOrgsByAllowed>[1];

const originalLog = console.log;
const originalError = console.error;
const originalStdoutWrite = process.stdout.write;

beforeEach(() => {
  _resetAllowedOrgsCache();
  console.log = originalLog;
  console.error = originalError;
  process.stdout.write = originalStdoutWrite;
});

afterEach(() => {
  _resetAllowedOrgsCache();
  console.log = originalLog;
  console.error = originalError;
  process.stdout.write = originalStdoutWrite;
});

async function captureOutput<T>(fn: () => T | Promise<T>): Promise<{
  result: Awaited<T>;
  logs: string[];
  errors: string[];
  writes: string[];
}> {
  const logs: string[] = [];
  const errors: string[] = [];
  const writes: string[] = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    const result = await fn();
    return { result, logs, errors, writes };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
  }
}

describe("fetchAllowedOrgs additional branches", () => {
  test("treats a whitespace-only gh login as a cached auth failure", () => {
    let calls = 0;
    const first = fetchAllowedOrgs((cmd) => {
      calls += 1;
      expect(cmd).toBe("gh api user --jq .login 2>/dev/null");
      return "  \n";
    });

    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.reason).toContain("empty login");

    const second = fetchAllowedOrgs(() => {
      throw new Error("cache should avoid this call");
    });

    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  test("ignores blank org lines while preserving the authenticated user", () => {
    const result = fetchAllowedOrgs((cmd) => {
      if (cmd.startsWith("gh api user --jq")) return "nat\n";
      if (cmd.startsWith("gh api user/orgs")) return "\nSoul-Brews-Studio\n  \nlaris-co\n";
      throw new Error(`unexpected command: ${cmd}`);
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.orgs].sort()).toEqual(["Soul-Brews-Studio", "laris-co", "nat"].sort());
  });
});

describe("readTtyAnswer additional branches", () => {
  test("can return a real answer on the third read after leftover whitespace", () => {
    const reads: ReturnType<TtyReader>[] = [
      { ok: true, text: "\n", n: 1 },
      { ok: true, text: "   \n", n: 4 },
      { ok: true, text: "No\n", n: 3 },
    ];
    let index = 0;

    expect(readTtyAnswer(() => reads[index++] ?? { ok: false })).toBe("no");
    expect(index).toBe(3);
  });

  test("returns null when tty disappears after a skipped whitespace read", () => {
    const reads: ReturnType<TtyReader>[] = [
      { ok: true, text: "\n", n: 1 },
      { ok: false },
    ];
    let index = 0;

    expect(readTtyAnswer(() => reads[index++] ?? { ok: false })).toBeNull();
    expect(index).toBe(2);
  });
});

describe("scanOrgs additional branches", () => {
  test("continues past malformed or url-less gh JSON and stops at first valid URL", async () => {
    const orgs: OrgEntry[] = [
      { name: "bad-json", source: "local" },
      { name: "no-url", source: "config" },
      { name: "found-org", source: "local" },
      { name: "never-scanned", source: "local" },
    ];
    const probed: string[] = [];

    const { result } = await captureOutput(() => scanOrgs("sprite", orgs, (cmd) => {
      const slug = cmd.match(/gh repo view '([^']+)'/)?.[1];
      if (!slug) throw new Error(`unexpected command: ${cmd}`);
      probed.push(slug);
      if (slug.startsWith("bad-json/")) return "{";
      if (slug.startsWith("no-url/")) return JSON.stringify({ name: "sprite-oracle" });
      if (slug.startsWith("found-org/")) return JSON.stringify({ url: "https://github.com/found-org/sprite-oracle" });
      throw new Error("should not scan after first match");
    }));

    expect(result).toEqual({ org: "found-org", url: "https://github.com/found-org/sprite-oracle" });
    expect(probed).toEqual([
      "bad-json/sprite-oracle",
      "no-url/sprite-oracle",
      "found-org/sprite-oracle",
    ]);
  });
});

describe("filterOrgsByAllowed additional branches", () => {
  test("is case-sensitive and preserves the original order and source labels", () => {
    const orgs: OrgEntry[] = [
      { name: "Team", source: "local" },
      { name: "team", source: "config" },
      { name: "Beta", source: "local" },
      { name: "beta", source: "config" },
    ];
    const allowed: Allowed = { ok: true, user: "nat", orgs: new Set(["team", "Beta"]) };

    expect(filterOrgsByAllowed(orgs, allowed)).toEqual([
      { name: "team", source: "config" },
      { name: "Beta", source: "local" },
    ]);
  });
});

describe("scanSuggestOracle additional branches", () => {
  test("uses configured githubOrgs when ghq list fails and clones the first found repo", async () => {
    const execCalls: string[] = [];
    const probed: string[] = [];
    const hostCalls: string[] = [];

    const { result } = await captureOutput(() => scanSuggestOracle("spark", {
      execFn: (cmd) => {
        execCalls.push(cmd);
        if (cmd === "gh --version 2>/dev/null") return "gh version 2.50.0";
        if (cmd === "ghq list") throw new Error("ghq unavailable");
        if (cmd.startsWith("gh api user --jq")) return "nat\n";
        if (cmd.startsWith("gh api user/orgs")) return "allowed-one\nallowed-two\n";
        if (cmd.startsWith("gh repo view ")) {
          const slug = cmd.match(/gh repo view '([^']+)'/)?.[1];
          if (!slug) throw new Error(`bad repo command: ${cmd}`);
          probed.push(slug);
          if (slug === "allowed-two/spark-oracle") {
            return JSON.stringify({ url: "https://github.com/allowed-two/spark-oracle" });
          }
          throw new Error("not found");
        }
        throw new Error(`unexpected command: ${cmd}`);
      },
      promptFn: () => true,
      configFn: () => ({ githubOrgs: ["allowed-one", "blocked-org", "allowed-two"] }),
      hostExecFn: async (cmd) => {
        hostCalls.push(cmd);
        if (cmd.startsWith("ghq get -u")) return "";
        if (cmd.startsWith("ghq list --full-path")) return "/repos/allowed-two/spark-oracle\n";
        throw new Error(`unexpected host command: ${cmd}`);
      },
    }));

    expect(execCalls).toContain("ghq list");
    expect(probed).toEqual(["allowed-one/spark-oracle", "allowed-two/spark-oracle"]);
    expect(probed).not.toContain("blocked-org/spark-oracle");
    expect(hostCalls[0]).toBe("ghq get -u 'https://github.com/allowed-two/spark-oracle'");
    expect(result).toEqual({
      repoPath: "/repos/allowed-two/spark-oracle",
      repoName: "spark-oracle",
      parentDir: "/repos/allowed-two",
    });
  });

  test("falls back to all-local on gh user lookup failure but does not scan in non-interactive mode", async () => {
    const repoViews: string[] = [];

    const { result, errors, logs } = await captureOutput(() => scanSuggestOracle("quiet", {
      execFn: (cmd) => {
        if (cmd === "gh --version 2>/dev/null") return "gh version 2.50.0";
        if (cmd === "ghq list") return "github.com/alpha/repo\ngithub.com/beta/repo\n";
        if (cmd.startsWith("gh api user --jq")) throw new Error("offline");
        if (cmd.startsWith("gh repo view ")) {
          repoViews.push(cmd);
          throw new Error("prompt should prevent scanning");
        }
        throw new Error(`unexpected command: ${cmd}`);
      },
      promptFn: () => null,
      configFn: () => ({}),
      hostExecFn: async () => {
        throw new Error("hostExec should not run");
      },
    }));

    expect(result).toBeNull();
    expect(repoViews).toEqual([]);
    expect(errors.some((line) => line.includes("org-scope filter unavailable"))).toBe(true);
    expect(logs.some((line) => line.includes("non-interactive"))).toBe(true);
  });

  test("when org listing fails, scans only the authenticated user from local orgs", async () => {
    const probed: string[] = [];

    const { result } = await captureOutput(() => scanSuggestOracle("sprite", {
      execFn: (cmd) => {
        if (cmd === "gh --version 2>/dev/null") return "gh version 2.50.0";
        if (cmd === "ghq list") return "github.com/nat/dotfiles\ngithub.com/team/repo\n";
        if (cmd.startsWith("gh api user --jq")) return "nat\n";
        if (cmd.startsWith("gh api user/orgs")) throw new Error("read:org missing");
        if (cmd.startsWith("gh repo view ")) {
          const slug = cmd.match(/gh repo view '([^']+)'/)?.[1];
          if (slug) probed.push(slug);
          throw new Error("not found");
        }
        throw new Error(`unexpected command: ${cmd}`);
      },
      promptFn: () => true,
      configFn: () => ({}),
      hostExecFn: async () => {
        throw new Error("hostExec should not run without a found repo");
      },
    }));

    expect(result).toBeNull();
    expect(probed).toEqual(["nat/sprite-oracle"]);
  });
});
