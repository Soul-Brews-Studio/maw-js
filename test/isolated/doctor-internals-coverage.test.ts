/** Isolated coverage for doctor internals that shell out or scan local worktrees. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type ExecResult = string | Error;

const HOME = "/tmp/doctor-internals-home";
const GHQ = "/tmp/doctor-internals-ghq";
const CONVENTIONAL = `${HOME}/Code/github.com/Soul-Brews-Studio/maw-js`;

const originalLog = console.log;
const originalMawJsSource = process.env.MAW_JS_SOURCE;

let homeDir = HOME;
let logs: string[] = [];
let execCalls: string[] = [];

let existingPaths = new Set<string>();
let directoryPaths = new Set<string>();
let readdirEntries = new Map<string, string[]>();
let readdirFailures = new Set<string>();
let statFailures = new Set<string>();
let existsFailures = new Set<string>();

let ghqListResult: ExecResult = new Error("ghq list unavailable");
let ghqRootResult: ExecResult = new Error("ghq root unavailable");
let gitBranchResult: ExecResult = "alpha\n";
let alphaRefExists = true;
let revListResult: ExecResult = "0\n";
let tmuxWindowsResult: ExecResult = "";

function valueOrThrow(value: ExecResult): string {
  if (value instanceof Error) throw value;
  return value;
}

function resetFakes() {
  homeDir = HOME;
  logs = [];
  execCalls = [];
  existingPaths = new Set<string>();
  directoryPaths = new Set<string>();
  readdirEntries = new Map<string, string[]>();
  readdirFailures = new Set<string>();
  statFailures = new Set<string>();
  existsFailures = new Set<string>();
  ghqListResult = new Error("ghq list unavailable");
  ghqRootResult = new Error("ghq root unavailable");
  gitBranchResult = "alpha\n";
  alphaRefExists = true;
  revListResult = "0\n";
  tmuxWindowsResult = "";
  delete process.env.MAW_JS_SOURCE;
  console.log = (line?: unknown) => {
    logs.push(String(line ?? ""));
  };
}

function addDir(path: string, entries: string[] = []) {
  existingPaths.add(path);
  directoryPaths.add(path);
  readdirEntries.set(path, entries);
}

function addGitRepo(path: string) {
  addDir(path);
  existingPaths.add(`${path}/.git`);
}

mock.module("os", () => ({
  homedir: () => homeDir,
}));

mock.module("fs", () => ({
  existsSync: (path: string) => {
    if (existsFailures.has(path)) throw new Error(`exists failed: ${path}`);
    return existingPaths.has(path);
  },
  readdirSync: (path: string) => {
    if (readdirFailures.has(path)) throw new Error(`readdir failed: ${path}`);
    const entries = readdirEntries.get(path);
    if (!entries) throw new Error(`unexpected readdirSync: ${path}`);
    return entries;
  },
  statSync: (path: string) => {
    if (statFailures.has(path)) throw new Error(`stat failed: ${path}`);
    return {
      isDirectory: () => directoryPaths.has(path),
    };
  },
}));

mock.module("child_process", () => ({
  execSync: (cmd: string) => {
    execCalls.push(cmd);
    if (cmd.includes("ghq list")) return valueOrThrow(ghqListResult);
    if (cmd.includes("ghq root")) return valueOrThrow(ghqRootResult);
    if (cmd.includes("branch --show-current")) return valueOrThrow(gitBranchResult);
    if (cmd.includes("rev-parse --verify 'alpha'")) {
      if (!alphaRefExists) throw new Error("missing alpha");
      return "alpha\n";
    }
    if (cmd.includes("rev-list --count")) return valueOrThrow(revListResult);
    if (cmd.includes("tmux list-windows")) return valueOrThrow(tmuxWindowsResult);
    throw new Error(`unexpected execSync: ${cmd}`);
  },
}));

const { checkMawJsBranch } = await import(
  "../../src/vendor/mpr-plugins/doctor/internal/maw-js-branch-check.ts?doctor-internals-coverage"
);
const { checkStillbornWorktrees, dirNameToWindowName } = await import(
  "../../src/vendor/mpr-plugins/doctor/internal/stillborn-worktrees.ts?doctor-internals-coverage"
);

beforeEach(resetFakes);

afterEach(() => {
  console.log = originalLog;
  if (originalMawJsSource === undefined) {
    delete process.env.MAW_JS_SOURCE;
  } else {
    process.env.MAW_JS_SOURCE = originalMawJsSource;
  }
});

describe("checkMawJsBranch", () => {
  test("trusts an explicit MAW_JS_SOURCE and does not fall back when it is not a git repo", async () => {
    process.env.MAW_JS_SOURCE = "/missing/maw-js";
    ghqListResult = "github.com/Soul-Brews-Studio/maw-js\n";
    ghqRootResult = `${GHQ}\n`;
    addGitRepo(`${GHQ}/github.com/Soul-Brews-Studio/maw-js`);

    const result = await checkMawJsBranch();

    expect(result).toEqual({
      name: "maw-js:branch",
      ok: true,
      message: "no local maw-js clone found (set $MAW_JS_SOURCE or clone to ~/Code/github.com/Soul-Brews-Studio/maw-js)",
    });
    expect(execCalls).toEqual([]);
  });

  test("reports unreadable HEAD and the happy alpha branch path", async () => {
    const repo = "/tmp/maw'js";
    process.env.MAW_JS_SOURCE = repo;
    addGitRepo(repo);

    gitBranchResult = "";
    const unreadable = await checkMawJsBranch();

    gitBranchResult = "alpha\n";
    const alpha = await checkMawJsBranch();

    expect(unreadable).toEqual({
      name: "maw-js:branch",
      ok: true,
      message: `maw-js found at ${repo} but git HEAD unreadable — skipping`,
    });
    expect(alpha).toEqual({
      name: "maw-js:branch",
      ok: true,
      message: `on alpha @ ${repo}`,
    });
    expect(execCalls[0]).toContain("maw'\\''js");
  });

  test("compares non-alpha branches against alpha including skip, parity, and drift outcomes", async () => {
    const repo = "/tmp/maw-js";
    process.env.MAW_JS_SOURCE = repo;
    addGitRepo(repo);
    gitBranchResult = "feature/doctor\n";

    alphaRefExists = false;
    const noAlpha = await checkMawJsBranch();

    alphaRefExists = true;
    revListResult = "not-a-number\n";
    const compareUnknown = await checkMawJsBranch();

    revListResult = "0\n";
    const parity = await checkMawJsBranch();

    revListResult = "1\n";
    const oneBehind = await checkMawJsBranch();

    revListResult = "2\n";
    const twoBehind = await checkMawJsBranch();

    expect(noAlpha).toEqual({
      name: "maw-js:branch",
      ok: true,
      message: "on 'feature/doctor' — no local alpha ref to compare against",
    });
    expect(compareUnknown).toEqual({
      name: "maw-js:branch",
      ok: true,
      message: "on 'feature/doctor' — could not compare with alpha",
    });
    expect(parity).toEqual({
      name: "maw-js:branch",
      ok: true,
      message: "on 'feature/doctor' — at parity with alpha",
    });
    expect(oneBehind).toEqual({
      name: "maw-js:branch",
      ok: false,
      message: `on 'feature/doctor' — alpha has 1 unmerged commit (cd ${repo} && git checkout alpha to align)`,
    });
    expect(twoBehind).toEqual({
      name: "maw-js:branch",
      ok: false,
      message: `on 'feature/doctor' — alpha has 2 unmerged commits (cd ${repo} && git checkout alpha to align)`,
    });
  });

  test("resolves maw-js through ghq and conventional fallbacks", async () => {
    ghqListResult = "github.com/Soul-Brews-Studio/maw-js\n";
    ghqRootResult = `${GHQ}\n`;
    addGitRepo(`${GHQ}/github.com/Soul-Brews-Studio/maw-js`);

    const ghq = await checkMawJsBranch();

    resetFakes();
    ghqListResult = "github.com/Soul-Brews-Studio/maw-js\n";
    ghqRootResult = new Error("ghq root boom");
    addGitRepo(CONVENTIONAL);

    const rootFallback = await checkMawJsBranch();

    resetFakes();
    ghqListResult = new Error("ghq list boom");
    addGitRepo(CONVENTIONAL);

    const listFallback = await checkMawJsBranch();

    expect(ghq.message).toBe(`on alpha @ ${GHQ}/github.com/Soul-Brews-Studio/maw-js`);
    expect(rootFallback.message).toBe(`on alpha @ ${CONVENTIONAL}`);
    expect(listFallback.message).toBe(`on alpha @ ${CONVENTIONAL}`);
  });

  test("returns no clone when ghq match is not a repo and the conventional probe fails", async () => {
    ghqListResult = "github.com/Soul-Brews-Studio/maw-js\n";
    ghqRootResult = `${GHQ}\n`;
    existsFailures.add(`${CONVENTIONAL}/.git`);

    const result = await checkMawJsBranch();

    expect(result).toEqual({
      name: "maw-js:branch",
      ok: true,
      message: "no local maw-js clone found (set $MAW_JS_SOURCE or clone to ~/Code/github.com/Soul-Brews-Studio/maw-js)",
    });
    expect(execCalls).toEqual(["ghq list 2>/dev/null", "ghq root 2>/dev/null"]);
  });

  test("skips safely when git commands throw after a valid repo is found", async () => {
    const repo = "/tmp/maw-js";
    process.env.MAW_JS_SOURCE = repo;
    addGitRepo(repo);

    gitBranchResult = new Error("branch failed");
    const unreadable = await checkMawJsBranch();

    gitBranchResult = "topic\n";
    alphaRefExists = true;
    revListResult = new Error("rev-list failed");
    const compareFailed = await checkMawJsBranch();

    expect(unreadable.message).toBe(`maw-js found at ${repo} but git HEAD unreadable — skipping`);
    expect(compareFailed).toEqual({
      name: "maw-js:branch",
      ok: true,
      message: "on 'topic' — could not compare with alpha",
    });
  });
});

describe("stillborn worktree internals", () => {
  test("maps worktree directory names to expected tmux window names", () => {
    expect(dirNameToWindowName("discord-oracle.wt-1-awaken")).toBe("discord-awaken");
    expect(dirNameToWindowName("neo-oracle.wt-3-feature-foo")).toBe("neo-feature-foo");
    expect(dirNameToWindowName("myrepo.wt-task")).toBe("myrepo-task");
    expect(dirNameToWindowName(`${GHQ}/github.com/Soul-Brews-Studio/mawjs-oracle/agents/12-codex-headless`))
      .toBe("mawjs-codex-headless");
    expect(dirNameToWindowName(`${GHQ}/github.com/Soul-Brews-Studio/plain-repo/agents/researcher`))
      .toBe("plain-repo-researcher");
    expect(dirNameToWindowName("plain-directory")).toBe("plain-directory");
  });

  test("skips when neither ghq root nor ~/Code fallback is available", () => {
    ghqRootResult = new Error("no ghq");

    const result = checkStillbornWorktrees();

    expect(result).toEqual({
      name: "worktrees:stillborn",
      ok: true,
      message: "ghq root unavailable — skipping worktree scan",
    });
    expect(execCalls).toEqual(["ghq root 2>/dev/null"]);
  });

  test("reports no worktrees for missing or unreadable github roots", () => {
    ghqRootResult = `${GHQ}\n`;
    const missingGithubBase = checkStillbornWorktrees();

    resetFakes();
    ghqRootResult = `${GHQ}\n`;
    addDir(`${GHQ}/github.com`);
    readdirFailures.add(`${GHQ}/github.com`);
    const unreadableGithubBase = checkStillbornWorktrees();

    expect(missingGithubBase).toEqual({
      name: "worktrees:stillborn",
      ok: true,
      message: "no .wt-* directories found",
    });
    expect(unreadableGithubBase).toEqual({
      name: "worktrees:stillborn",
      ok: true,
      message: "no .wt-* directories found",
    });
  });

  test("uses ~/Code fallback and reports all-active worktrees without warnings", () => {
    ghqRootResult = new Error("ghq missing");
    addDir(`${HOME}/Code`);
    addDir(`${HOME}/Code/github.com`, ["Soul-Brews-Studio"]);
    addDir(`${HOME}/Code/github.com/Soul-Brews-Studio`, ["neo-oracle.wt-1-awaken"]);
    addDir(`${HOME}/Code/github.com/Soul-Brews-Studio/neo-oracle.wt-1-awaken`);
    tmuxWindowsResult = "neo-awaken\n";

    const result = checkStillbornWorktrees();

    expect(result).toEqual({
      name: "worktrees:stillborn",
      ok: true,
      message: "1 active worktree, 0 stillborn",
    });
    expect(logs).toEqual([]);
  });

  test("walks ghq orgs defensively and reports stillborn samples plus overflow", () => {
    ghqRootResult = `${GHQ}\n`;
    addDir(`${GHQ}/github.com`, ["Soul-Brews-Studio", "file-org", "broken-org", "Other"]);
    addDir(`${GHQ}/github.com/Soul-Brews-Studio`, [
      "neo-oracle.wt-1-awaken",
      "repo.wt-task",
      "plain",
      "bad.wt-1-skip",
      "notdir.wt-1-skip",
    ]);
    addDir(`${GHQ}/github.com/Soul-Brews-Studio/neo-oracle.wt-1-awaken`);
    addDir(`${GHQ}/github.com/Soul-Brews-Studio/repo.wt-task`);
    statFailures.add(`${GHQ}/github.com/Soul-Brews-Studio/bad.wt-1-skip`);
    addDir(`${GHQ}/github.com/Other`, [
      "ghost-oracle.wt-1-task-a",
      "ghost-oracle.wt-2-task-b",
      "plain",
      "ghost-oracle.wt-3-task-c",
      "ghost-oracle.wt-4-task-d",
      "ghost-oracle.wt-5-task-e",
      "ghost-oracle.wt-6-task-f",
    ]);
    for (const name of [
      "ghost-oracle.wt-1-task-a",
      "ghost-oracle.wt-2-task-b",
      "ghost-oracle.wt-3-task-c",
      "ghost-oracle.wt-4-task-d",
      "ghost-oracle.wt-5-task-e",
      "ghost-oracle.wt-6-task-f",
    ]) {
      addDir(`${GHQ}/github.com/Other/${name}`);
    }
    statFailures.add(`${GHQ}/github.com/broken-org`);
    tmuxWindowsResult = "neo-awaken\nrepo-task-\n";

    const result = checkStillbornWorktrees();

    expect(result).toEqual({
      name: "worktrees:stillborn",
      ok: false,
      message: "6 stillborn (no tmux window) | 2 active",
    });
    expect(logs).toHaveLength(6);
    expect(logs[0]).toContain("stillborn: ghost-oracle.wt-1-task-a (cleanup: maw done ghost-task-a)");
    expect(logs[4]).toContain("stillborn: ghost-oracle.wt-5-task-e (cleanup: maw done ghost-task-e)");
    expect(logs[5]).toContain("... (+1 more)");
  });

  test("walks nested agents paths defensively while classifying legacy worktrees", () => {
    ghqRootResult = `${GHQ}\n`;
    addDir(`${GHQ}/github.com`, ["Soul-Brews-Studio"]);
    addDir(`${GHQ}/github.com/Soul-Brews-Studio`, [
      "mawjs-oracle",
      "neo-oracle.wt-1-awaken",
    ]);
    addDir(`${GHQ}/github.com/Soul-Brews-Studio/mawjs-oracle`);
    addDir(`${GHQ}/github.com/Soul-Brews-Studio/mawjs-oracle/agents`, [
      "12-codex-headless",
      "broken-agent",
    ]);
    addDir(`${GHQ}/github.com/Soul-Brews-Studio/mawjs-oracle/agents/12-codex-headless`);
    statFailures.add(`${GHQ}/github.com/Soul-Brews-Studio/mawjs-oracle/agents/broken-agent`);
    addDir(`${GHQ}/github.com/Soul-Brews-Studio/neo-oracle.wt-1-awaken`);
    tmuxWindowsResult = "neo-awaken\n";

    const result = checkStillbornWorktrees();

    expect(result).toEqual({
      name: "worktrees:stillborn",
      ok: true,
      message: "1 active worktree, 0 stillborn",
    });
    expect(logs).toEqual([]);
  });

  test("treats worktrees as stillborn when tmux window listing is unavailable", () => {
    ghqRootResult = `${GHQ}\n`;
    addDir(`${GHQ}/github.com`, ["Soul-Brews-Studio"]);
    addDir(`${GHQ}/github.com/Soul-Brews-Studio`, ["lonely-oracle.wt-1-fix"]);
    addDir(`${GHQ}/github.com/Soul-Brews-Studio/lonely-oracle.wt-1-fix`);
    tmuxWindowsResult = new Error("tmux unavailable");

    const result = checkStillbornWorktrees();

    expect(result).toEqual({
      name: "worktrees:stillborn",
      ok: false,
      message: "1 stillborn (no tmux window) | 0 active",
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("stillborn: lonely-oracle.wt-1-fix (cleanup: maw done lonely-fix)");
  });
});
