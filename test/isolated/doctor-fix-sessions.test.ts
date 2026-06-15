/** @maw-test-isolate */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resetGhqRootCache } from "../../src/config/ghq-root";
import { cmdDoctor } from "../../src/vendor/mpr-plugins/doctor/impl";
import {
  discoverDoubledGithubSessionPairs,
  encodeClaudeProjectPath,
  fixDoubledGithubSessions,
  type FixSessionsDeps,
} from "../../src/vendor/mpr-plugins/doctor/internal/fix-sessions";

const created: string[] = [];
const originalGhqRoot = process.env.GHQ_ROOT;
const originalClaudeHome = process.env.CLAUDE_HOME;
const originalHome = process.env.HOME;

function tempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `maw-${label}-`));
  created.push(dir);
  return dir;
}

function restoreEnv() {
  if (originalGhqRoot === undefined) delete process.env.GHQ_ROOT;
  else process.env.GHQ_ROOT = originalGhqRoot;
  if (originalClaudeHome === undefined) delete process.env.CLAUDE_HOME;
  else process.env.CLAUDE_HOME = originalClaudeHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  resetGhqRootCache();
}

afterEach(() => {
  restoreEnv();
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = tempRoot("doctor-fix-sessions");
  const ghqRoot = join(root, "Code");
  const claudeHome = join(root, "claude");
  const quarantine = join(root, "quarantine");
  const doubledWithCanonical = join(ghqRoot, "github.com", "github.com", "Org", "has-sessions");
  const canonical = join(ghqRoot, "github.com", "Org", "has-sessions");
  const doubledMissingCanonical = join(ghqRoot, "github.com", "github.com", "Org", "needs-clone");
  const doubledNoSessions = join(ghqRoot, "github.com", "github.com", "Org", "cleanup-only");
  for (const dir of [doubledWithCanonical, canonical, doubledMissingCanonical, doubledNoSessions]) {
    mkdirSync(dir, { recursive: true });
  }
  const sessionDir = join(claudeHome, "projects", encodeClaudeProjectPath(doubledWithCanonical));
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "session.jsonl"), JSON.stringify({ cwd: doubledWithCanonical }));
  const cloneSessionDir = join(claudeHome, "projects", encodeClaudeProjectPath(doubledMissingCanonical));
  mkdirSync(cloneSessionDir, { recursive: true });
  writeFileSync(join(cloneSessionDir, "clone.jsonl"), JSON.stringify({ cwd: doubledMissingCanonical }));
  return { root, ghqRoot, claudeHome, quarantine, doubledWithCanonical, canonical, doubledMissingCanonical, doubledNoSessions };
}

describe("maw doctor --fix-sessions", () => {
  test("detects doubled github.com dirs and plans remap / clone+remap / cleanup-only", () => {
    const f = fixture();
    const pairs = discoverDoubledGithubSessionPairs({
      ghqRoot: () => f.ghqRoot,
      claudeHome: () => f.claudeHome,
      quarantineRoot: () => f.quarantine,
      exists: (p) => require("fs").existsSync(p),
      readdir: (p) => require("fs").readdirSync(p),
      stat: (p) => require("fs").statSync(p),
      execFile: async () => {},
      copyDir: async () => {},
      moveDir: async () => {},
    }, f.quarantine);

    expect(pairs.map(p => [p.doubled, p.action, p.sessionCount])).toEqual([
      [f.doubledNoSessions, "cleanup-only", 0],
      [f.doubledWithCanonical, "remap", 1],
      [f.doubledMissingCanonical, "clone+remap", 1],
    ]);
    expect(pairs.find(p => p.action === "remap")?.canonical).toBe(f.canonical);
  });

  test("dry-run lists all dirs and planned actions", async () => {
    const f = fixture();
    const result = await fixDoubledGithubSessions({ dryRun: true }, {
      ghqRoot: () => f.ghqRoot,
      claudeHome: () => f.claudeHome,
      quarantineRoot: () => f.quarantine,
    });

    expect(result.ok).toBe(true);
    expect(result.pairs).toHaveLength(3);
    expect(result.pairs.every(p => p.outcome === "planned")).toBe(true);
    expect(result.checks[0]!.message).toContain("dry-run");
    expect(result.checks[0]!.message).toContain("remap=1");
    expect(result.checks[0]!.message).toContain("clone+remap=1");
    expect(result.checks[0]!.message).toContain("cleanup-only=1");
  });

  test("apply uses staged claude-path-migrate, --check, rsync --ignore-existing, and mv quarantine", async () => {
    const f = fixture();
    const calls: Array<[string, string[]]> = [];
    const moved: string[][] = [];
    const deps: FixSessionsDeps = {
      ghqRoot: () => f.ghqRoot,
      claudeHome: () => f.claudeHome,
      quarantineRoot: () => f.quarantine,
      execFile: async (file, args) => { calls.push([file, args]); },
      copyDir: async () => {},
      moveDir: async (from, to) => { moved.push(["mv", from, to]); },
    };

    const result = await fixDoubledGithubSessions({ dryRun: false }, deps);

    expect(result.ok).toBe(true);
    expect(calls.some(([file, args]) => file === "ghq" && args.join(" ") === "get -u github.com/Org/needs-clone")).toBe(true);
    const migrateCalls = calls.filter(([file]) => file === "claude-path-migrate");
    expect(migrateCalls.length).toBe(4);
    expect(migrateCalls.some(([, args]) => args.includes("--check"))).toBe(true);
    expect(calls.some(([file, args]) => file === "rsync" && args.includes("-a") && args.includes("--ignore-existing"))).toBe(true);
    expect(moved).toHaveLength(3);
    expect(moved.every(([cmd]) => cmd === "mv")).toBe(true);
  });

  test("--json emits top-level pairs for external map pipelines", async () => {
    const f = fixture();
    process.env.GHQ_ROOT = f.ghqRoot;
    process.env.CLAUDE_HOME = f.claudeHome;
    process.env.HOME = f.root;
    resetGhqRootCache();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
    try {
      await cmdDoctor(["--fix-sessions", "--dry-run", "--json"]);
    } finally {
      console.log = origLog;
    }
    const payload = JSON.parse(logs.join("\n"));
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(payload.pairs).toHaveLength(3);
    expect(payload.pairs.map((p: any) => p.action).sort()).toEqual(["cleanup-only", "clone+remap", "remap"]);
    expect(payload.pairs[0]).toHaveProperty("doubled");
    expect(payload.pairs[0]).toHaveProperty("canonical");
  });
});
