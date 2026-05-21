/**
 * Isolated coverage for src/vendor/mpr-plugins/done/done-worktree.ts.
 *
 * The module imports the SDK transport and fleet directory at module load time,
 * so keep this file isolated and mock those seams before importing it.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SANDBOX = mkdtempSync(join(tmpdir(), "maw-done-worktree-"));
const FLEET_DIR = join(SANDBOX, "fleet");
const REPOS_ROOT = join(SANDBOX, "repos");

type HostExecHandler = (command: string) => string | Promise<string>;

let hostExecCalls: string[] = [];
let hostExecHandler: HostExecHandler = () => "";

mock.module("maw-js/sdk", () => ({
  FLEET_DIR,
  hostExec: async (command: string) => {
    hostExecCalls.push(command);
    return await hostExecHandler(command);
  },
}));

const {
  removeFromFleetConfig,
  removeWorktreeByGhqScan,
  removeWorktreeViaConfig,
} = await import("../../src/vendor/mpr-plugins/done/done-worktree.ts?done-worktree-coverage");

function resetSandbox() {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(FLEET_DIR, { recursive: true });
  mkdirSync(REPOS_ROOT, { recursive: true });
}

function writeFleetConfig(file: string, payload: unknown) {
  writeFileSync(join(FLEET_DIR, file), JSON.stringify(payload, null, 2));
}

function readFleetConfig(file: string) {
  return JSON.parse(readFileSync(join(FLEET_DIR, file), "utf-8"));
}

async function captureConsole(fn: () => Promise<unknown> | unknown) {
  const originalLog = console.log;
  const originalError = console.error;
  const lines: string[] = [];
  const capture = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
  console.log = capture;
  console.error = capture;
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

beforeEach(() => {
  resetSandbox();
  hostExecCalls = [];
  hostExecHandler = () => "";
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("removeWorktreeViaConfig", () => {
  test("removes a configured worktree and deletes its non-main branch", async () => {
    writeFleetConfig("oracle.json", {
      windows: [{ name: "FeaturePane", repo: "Soul-Brews-Studio/maw-js.wt-123-feature" }],
    });

    hostExecHandler = (command) => {
      if (command.includes("rev-parse --abbrev-ref HEAD")) return "feature/done-cleanup\n";
      return "";
    };

    const output = await captureConsole(async () => {
      expect(await removeWorktreeViaConfig("featurepane", REPOS_ROOT)).toBe(true);
    });

    const fullPath = join(REPOS_ROOT, "Soul-Brews-Studio/maw-js.wt-123-feature");
    const mainPath = join(REPOS_ROOT, "Soul-Brews-Studio", "maw-js");
    expect(hostExecCalls).toEqual([
      `git -C '${fullPath}' rev-parse --abbrev-ref HEAD`,
      `git -C '${mainPath}' worktree remove '${fullPath}' --force`,
      `git -C '${mainPath}' worktree prune`,
      `git -C '${mainPath}' branch -d 'feature/done-cleanup'`,
    ]);
    expect(output).toContain("removed worktree Soul-Brews-Studio/maw-js.wt-123-feature");
    expect(output).toContain("deleted branch feature/done-cleanup");
  });

  test("returns false after reporting a worktree removal failure", async () => {
    writeFleetConfig("oracle.json", {
      windows: [{ name: "stuck", repo: "org/repo.wt-stuck" }],
    });
    hostExecHandler = (command) => {
      if (command.includes("worktree remove")) throw new Error("busy worktree");
      return "main\n";
    };

    const output = await captureConsole(async () => {
      expect(await removeWorktreeViaConfig("stuck", REPOS_ROOT)).toBe(false);
    });

    expect(hostExecCalls.some(command => command.includes("worktree remove"))).toBe(true);
    expect(output).toContain("worktree remove failed: busy worktree");
  });

  test("ignores configured non-worktree repos", async () => {
    writeFleetConfig("oracle.json", {
      windows: [{ name: "plain", repo: "org/repo" }],
    });

    expect(await removeWorktreeViaConfig("plain", REPOS_ROOT)).toBe(false);
    expect(hostExecCalls).toEqual([]);
  });
});

describe("removeWorktreeByGhqScan", () => {
  test("removes only exact suffix matches from ghq scan results", async () => {
    const exact = join(REPOS_ROOT, "github.com", "org", "repo.wt-123-feature");
    const substringOnly = join(REPOS_ROOT, "github.com", "org", "repo.wt-feature-extra");
    const other = join(REPOS_ROOT, "github.com", "org", "other.wt-bugfix");

    hostExecHandler = (command) => {
      if (command.startsWith(`find '${REPOS_ROOT}'`)) {
        return [exact, substringOnly, other].join("\n");
      }
      if (command.includes("rev-parse --abbrev-ref HEAD")) return "feature/done\n";
      if (command.includes("branch -d")) throw new Error("branch still merged elsewhere");
      return "";
    };

    const output = await captureConsole(async () => {
      expect(await removeWorktreeByGhqScan("mother-feature", REPOS_ROOT)).toBe(true);
    });

    const mainPath = exact.replace("repo.wt-123-feature", "repo");
    expect(hostExecCalls).toEqual([
      `find '${REPOS_ROOT}' -maxdepth 3 -name '*.wt-*' -type d 2>/dev/null`,
      `git -C '${exact}' rev-parse --abbrev-ref HEAD`,
      `git -C '${mainPath}' worktree remove '${exact}' --force`,
      `git -C '${mainPath}' worktree prune`,
      `git -C '${mainPath}' branch -d 'feature/done'`,
    ]);
    expect(output).toContain("removed worktree repo.wt-123-feature");
    expect(output).not.toContain("repo.wt-feature-extra");
  });


  test("refuses ambiguous exact suffix matches without mutating worktrees", async () => {
    const one = join(REPOS_ROOT, "github.com", "org", "repo.wt-feature");
    const two = join(REPOS_ROOT, "github.com", "other", "repo.wt-feature");

    hostExecHandler = (command) => {
      if (command.startsWith(`find '${REPOS_ROOT}'`)) return [one, two].join("\n");
      throw new Error(`unexpected mutation: ${command}`);
    };

    const output = await captureConsole(async () => {
      expect(await removeWorktreeByGhqScan("mother-feature", REPOS_ROOT)).toBe(false);
    });

    expect(hostExecCalls).toEqual([`find '${REPOS_ROOT}' -maxdepth 3 -name '*.wt-*' -type d 2>/dev/null`]);
    expect(output).toContain("refusing to remove worktree 'feature' — matches 2 repos");
    expect(output).toContain(one);
    expect(output).toContain(two);
    expect(output).toContain("use fleet config or remove the exact worktree manually");
  });

  test("reports scan failures and returns false", async () => {
    hostExecHandler = () => {
      throw new Error("find denied");
    };

    const output = await captureConsole(async () => {
      expect(await removeWorktreeByGhqScan("mother-feature", REPOS_ROOT)).toBe(false);
    });

    expect(hostExecCalls).toHaveLength(1);
    expect(output).toContain("worktree scan failed: Error: find denied");
  });
});

describe("removeFromFleetConfig", () => {
  test("removes matching windows from all fleet json files", () => {
    writeFleetConfig("one.json", {
      windows: [
        { name: "Keep", repo: "org/keep" },
        { name: "DonePane", repo: "org/repo.wt-done" },
      ],
    });
    writeFleetConfig("two.json", {
      windows: [{ name: "donepane", repo: "org/other.wt-done" }],
    });
    writeFileSync(join(FLEET_DIR, "ignored.txt"), "not json");

    const output = captureConsole(() => {
      expect(removeFromFleetConfig("donepane")).toBe(true);
    });

    expect(readFleetConfig("one.json").windows).toEqual([{ name: "Keep", repo: "org/keep" }]);
    expect(readFleetConfig("two.json").windows).toEqual([]);
    return expect(output).resolves.toContain("removed from one.json");
  });

  test("returns false when no fleet config contains the window", () => {
    writeFleetConfig("one.json", { windows: [{ name: "Other", repo: "org/repo" }] });

    expect(removeFromFleetConfig("missing")).toBe(false);
    expect(readFleetConfig("one.json").windows).toEqual([{ name: "Other", repo: "org/repo" }]);
  });
});
