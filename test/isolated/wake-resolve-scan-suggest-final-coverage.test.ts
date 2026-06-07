/**
 * Final focused isolated function coverage for wake-resolve-scan-suggest.
 *
 * Uses injected exec/host deps plus a tiny mocked TTY reader so default prompt
 * and clone branches are covered without touching a real terminal, gh, or ghq.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const srcRoot = join(import.meta.dir, "../..");

let ttyReads: string[];
let ttyThrows: boolean;
let closedTtyFds: number[];
let logs: string[];
let errors: string[];
let writes: string[];
let exitCodes: number[];

const originalLog = console.log;
const originalError = console.error;
const originalStdoutWrite = process.stdout.write;
const originalExit = process.exit;
const originalPath = process.env.PATH;

mock.module("fs", () => ({
  openSync: () => {
    if (ttyThrows) throw new Error("tty unavailable");
    return 42;
  },
  readSync: (_fd: number, buf: Buffer, offset: number, length: number) => {
    if (ttyThrows) throw new Error("read failed");
    const bytes = Buffer.from(ttyReads.shift() ?? "");
    bytes.copy(buf, offset, 0, Math.min(bytes.length, length));
    return Math.min(bytes.length, length);
  },
  closeSync: (fd: number) => {
    closedTtyFds.push(fd);
  },
}));

mock.module(join(srcRoot, "src/sdk"), () => ({
  hostExec: async () => "",
}));

mock.module(join(srcRoot, "src/config"), () => ({
  loadConfig: () => ({}),
}));

mock.module(join(srcRoot, "src/core/util/terminal"), () => ({
  tlink: (url: string, label?: string) => label ?? url,
}));

const {
  _resetAllowedOrgsCache,
  buildOrgList,
  extractGhqOrgs,
  fetchAllowedOrgs,
  filterOrgsByAllowed,
  readTtyAnswer,
  scanOrgs,
  scanSuggestOracle,
} = await import("../../src/commands/shared/wake-resolve-scan-suggest");

function captureOutput(): void {
  logs = [];
  errors = [];
  writes = [];
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
}

beforeEach(() => {
  _resetAllowedOrgsCache();
  ttyReads = [];
  ttyThrows = false;
  closedTtyFds = [];
  exitCodes = [];
  captureOutput();
  process.env.PATH = originalPath;
  process.exit = ((code?: number) => {
    exitCodes.push(code ?? 0);
    throw new Error(`exit:${code ?? 0}`);
  }) as typeof process.exit;
});

afterEach(() => {
  _resetAllowedOrgsCache();
  console.log = originalLog;
  console.error = originalError;
  process.stdout.write = originalStdoutWrite;
  process.env.PATH = originalPath;
  process.exit = originalExit;
});

describe("wake-resolve-scan-suggest helpers in one process", () => {
  test("covers org extraction, filtering, cache success/failure, and tty reads", () => {
    expect(extractGhqOrgs("github.com/Beta/repo\ngithub.com/alpha/repo\nnot-ghq\n")).toEqual(["Beta", "alpha"]);

    expect(buildOrgList("github.com/local/repo\n", { githubOrgs: ["Config", "local"] })).toEqual([
      { name: "Config", source: "config" },
      { name: "local", source: "local" },
    ]);
    expect(buildOrgList("", { githubOrg: "Solo" })).toEqual([{ name: "Solo", source: "config" }]);

    const allowed = { ok: true as const, user: "nat", orgs: new Set(["team", "Beta"]) };
    expect(filterOrgsByAllowed([
      { name: "Team", source: "local" },
      { name: "team", source: "config" },
      { name: "Beta", source: "local" },
    ], allowed)).toEqual([
      { name: "team", source: "config" },
      { name: "Beta", source: "local" },
    ]);

    let calls = 0;
    const ok = fetchAllowedOrgs((cmd) => {
      calls += 1;
      if (cmd.startsWith("gh api user --jq")) return "nat\n";
      if (cmd.startsWith("gh api user/orgs")) return "\nSoul-Brews-Studio\n  \n";
      throw new Error(`unexpected command: ${cmd}`);
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect([...ok.orgs].sort()).toEqual(["Soul-Brews-Studio", "nat"]);
    expect(fetchAllowedOrgs(() => { throw new Error("cached"); })).toEqual(ok);
    expect(calls).toBe(2);

    _resetAllowedOrgsCache();
    const failed = fetchAllowedOrgs(() => "  \n");
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.reason).toContain("empty login");
    expect(fetchAllowedOrgs(() => { throw new Error("cached failure"); })).toEqual(failed);

    expect(readTtyAnswer(() => ({ ok: true, text: "YES\n", n: 4 }))).toBe("yes");
    let index = 0;
    const reads = [
      { ok: true as const, text: "\n", n: 1 },
      { ok: true as const, text: "  \n", n: 3 },
      { ok: true as const, text: "\t", n: 1 },
    ];
    expect(readTtyAnswer(() => reads[index++] ?? { ok: false })).toBeNull();

    ttyReads = ["\n", "No\n"];
    expect(readTtyAnswer()).toBe("no");
    expect(closedTtyFds).toEqual([42, 42]);

    ttyThrows = true;
    expect(readTtyAnswer()).toBeNull();
  });

  test("covers scanOrgs malformed, missing, found, and no-match paths", () => {
    const probed: string[] = [];
    const found = scanOrgs("sprite", [
      { name: "bad-json", source: "local" },
      { name: "no-url", source: "config" },
      { name: "found-org", source: "local" },
      { name: "never", source: "local" },
    ], (cmd) => {
      const slug = cmd.match(/gh repo view '([^']+)'/)?.[1];
      if (!slug) throw new Error(`bad repo command: ${cmd}`);
      probed.push(slug);
      if (slug.startsWith("bad-json/")) return "{";
      if (slug.startsWith("no-url/")) return JSON.stringify({ name: "sprite-oracle" });
      if (slug.startsWith("found-org/")) return JSON.stringify({ url: "https://github.com/found-org/sprite-oracle" });
      throw new Error("should not scan after first match");
    });

    expect(found).toEqual({ org: "found-org", url: "https://github.com/found-org/sprite-oracle" });
    expect(probed).toEqual(["bad-json/sprite-oracle", "no-url/sprite-oracle", "found-org/sprite-oracle"]);
    expect(logs.some((line) => line.includes("not found"))).toBe(true);

    logs = [];
    const none = scanOrgs("ghost-oracle", [{ name: "team", source: "local" }], () => {
      throw new Error("missing");
    });
    expect(none).toBeNull();
    expect(logs.some((line) => line.includes("not found"))).toBe(true);
  });

  test("covers scanSuggest default prompt yes/no/catch, default exec failure, org fallback, and clone branches", async () => {
    process.env.PATH = "";
    await expect(scanSuggestOracle("ghost", {
      configFn: () => ({}),
      allLocal: true,
      hostExecFn: async () => {
        throw new Error("host exec should not run after gh failure");
      },
    })).resolves.toBeNull();
    process.env.PATH = originalPath;

    errors = [];
    await expect(scanSuggestOracle("nogh", {
      execFn: (cmd) => {
        expect(cmd).toBe("gh --version 2>/dev/null");
        throw new Error("gh missing");
      },
      configFn: () => ({}),
      hostExecFn: async () => {
        throw new Error("host exec should not run when gh is missing");
      },
    })).resolves.toBeNull();
    expect(errors.some((line) => line.includes("gh cli required"))).toBe(true);

    errors = [];
    await expect(scanSuggestOracle("quiet", {
      execFn: (cmd) => {
        if (cmd === "gh --version 2>/dev/null") return "gh version 2.50.0\n";
        if (cmd === "ghq list") return "github.com/unowned/seed\n";
        if (cmd.startsWith("gh api user --jq")) return "nat\n";
        if (cmd.startsWith("gh api user/orgs")) return "shared\n";
        throw new Error(`unexpected command: ${cmd}`);
      },
      promptFn: () => {
        throw new Error("prompt should not run when filter removes all orgs");
      },
      configFn: () => ({}),
      hostExecFn: async () => {
        throw new Error("host exec should not run when filter removes all orgs");
      },
    })).resolves.toBeNull();
    expect(errors.some((line) => line.includes("no locally-cloned orgs are owned"))).toBe(true);

    errors = [];
    logs = [];
    writes = [];
    ttyReads = ["yes\n"];
    const hostCalls: string[] = [];
    await expect(scanSuggestOracle("spark", {
      execFn: (cmd) => {
        if (cmd === "gh --version 2>/dev/null") return "gh version 2.50.0\n";
        if (cmd === "ghq list") return "github.com/team/seed\n";
        if (cmd === "gh repo view 'team/spark-oracle' --json url 2>/dev/null") {
          return JSON.stringify({ url: "https://github.com/team/spark-oracle" });
        }
        throw new Error(`unexpected command: ${cmd}`);
      },
      configFn: () => ({}),
      allLocal: true,
      hostExecFn: async (cmd) => {
        hostCalls.push(cmd);
        if (cmd.startsWith("ghq get -u")) return "";
        if (cmd.startsWith("ghq list --full-path")) return "/repos/team/spark-oracle\n";
        throw new Error(`unexpected host command: ${cmd}`);
      },
    })).resolves.toEqual({
      repoPath: "/repos/team/spark-oracle",
      repoName: "spark-oracle",
      parentDir: "/repos/team",
    });
    expect(writes).toContain("Scan now? [y/N] ");
    expect(hostCalls).toEqual([
      "ghq get -u 'https://github.com/team/spark-oracle'",
      "ghq list --full-path | grep -i '/spark-oracle$' | head -1",
    ]);
    expect(logs.some((line) => line.includes("continuing wake"))).toBe(true);

    logs = [];
    writes = [];
    ttyReads = ["n\n"];
    await expect(scanSuggestOracle("sprite", {
      execFn: (cmd) => {
        if (cmd === "gh --version 2>/dev/null") return "gh version 2.50.0\n";
        if (cmd === "ghq list") return "github.com/team/seed\n";
        throw new Error(`unexpected command after prompt rejection: ${cmd}`);
      },
      configFn: () => ({}),
      allLocal: true,
      hostExecFn: async () => {
        throw new Error("host exec should not run after abort");
      },
    })).rejects.toThrow("exit:0");
    expect(exitCodes).toContain(0);
    expect(logs.some((line) => line.includes("aborted. Manually"))).toBe(true);

    logs = [];
    writes = [];
    process.stdout.write = (() => {
      throw new Error("write failed");
    }) as typeof process.stdout.write;
    await expect(scanSuggestOracle("quiet", {
      execFn: (cmd) => {
        if (cmd === "gh --version 2>/dev/null") return "gh version 2.50.0\n";
        if (cmd === "ghq list") return "github.com/team/seed\n";
        throw new Error(`unexpected command: ${cmd}`);
      },
      configFn: () => ({}),
      allLocal: true,
      hostExecFn: async () => {
        throw new Error("host exec should not run without consent");
      },
    })).resolves.toBeNull();
    expect(logs.some((line) => line.includes("non-interactive"))).toBe(true);
    process.stdout.write = originalStdoutWrite;
    captureOutput();

    errors = [];
    _resetAllowedOrgsCache();
    const noFound = await scanSuggestOracle("quiet", {
      execFn: (cmd) => {
        if (cmd === "gh --version 2>/dev/null") return "gh version 2.50.0\n";
        if (cmd === "ghq list") return "github.com/team/seed\n";
        if (cmd.startsWith("gh api user --jq")) throw new Error("offline");
        if (cmd.startsWith("gh repo view ")) throw new Error("missing");
        throw new Error(`unexpected command: ${cmd}`);
      },
      promptFn: () => true,
      configFn: () => ({}),
      hostExecFn: async () => {
        throw new Error("host exec should not run without a match");
      },
    });
    expect(noFound).toBeNull();
    expect(errors.some((line) => line.includes("org-scope filter unavailable"))).toBe(true);
    expect(errors.some((line) => line.includes("no org had quiet-oracle"))).toBe(true);

    errors = [];
    const cloneMissing = await scanSuggestOracle("sprite-oracle", {
      execFn: (cmd) => {
        if (cmd === "gh --version 2>/dev/null") return "gh version 2.50.0\n";
        if (cmd === "ghq list") return "github.com/team/seed\n";
        if (cmd === "gh repo view 'team/sprite-oracle' --json url 2>/dev/null") {
          return JSON.stringify({ url: "https://github.com/team/sprite-oracle" });
        }
        throw new Error(`unexpected command: ${cmd}`);
      },
      promptFn: () => true,
      configFn: () => ({}),
      allLocal: true,
      hostExecFn: async (cmd) => {
        if (cmd.startsWith("ghq get -u")) throw new Error("network offline");
        if (cmd.startsWith("ghq list --full-path")) return "\n";
        throw new Error(`unexpected host command: ${cmd}`);
      },
    });
    expect(cloneMissing).toBeNull();
    expect(errors.some((line) => line.includes("clone failed: network offline"))).toBe(true);
    expect(errors.some((line) => line.includes("clone succeeded but path not found"))).toBe(true);
  });
});
