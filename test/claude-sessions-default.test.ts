/** @maw-test-isolate @maw-test-isolate-cwd-neutral */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import {
  type ClaudeSessionDeps,
  __resetClaudeSessionCachesForTests,
  decodeProjectDir,
  listClaudeSessions,
} from "../src/core/fleet/claude-sessions";

const originalProjectsDir = process.env.MAW_CLAUDE_PROJECTS_DIR;
const originalSkipPidScan = process.env.MAW_CLAUDE_SKIP_PID_SCAN;
const created: string[] = [];

function restoreEnv() {
  if (originalProjectsDir === undefined) delete process.env.MAW_CLAUDE_PROJECTS_DIR;
  else process.env.MAW_CLAUDE_PROJECTS_DIR = originalProjectsDir;

  if (originalSkipPidScan === undefined) delete process.env.MAW_CLAUDE_SKIP_PID_SCAN;
  else process.env.MAW_CLAUDE_SKIP_PID_SCAN = originalSkipPidScan;
}

function tempPath(name: string): string {
  const path = join(
    // Claude's project directory encoding is lossy for "." and "-" path
    // segments; keep these fixtures under a stable dot-free temp root so
    // coverage runs with TMPDIR=tmp.XXXX do not alter decoded paths.
    realpathSync("/tmp"),
    `mawcs${process.pid}${Date.now()}${Math.random().toString(36).slice(2)}${name}`,
  );
  created.push(path);
  return path;
}

function encodeProjectPath(path: string): string {
  return path.replace(/^\//, "-").replace(/[/.]/g, "-");
}

function writeSession(
  projectsRoot: string,
  projectPath: string,
  sessionId: string,
  ageMs: number,
  body = "",
): string {
  const dir = join(projectsRoot, encodeProjectPath(projectPath));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, body);
  const d = new Date(Date.now() - ageMs);
  utimesSync(file, d, d);
  return file;
}

function initGitRepo(path: string) {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init"], { cwd: path, stdio: "ignore" });
  execFileSync("git", ["checkout", "-B", "main"], { cwd: path, stdio: "ignore" });
  writeFileSync(join(path, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: path, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=maw-test", "-c", "user.email=maw-test@example.invalid", "commit", "-m", "fixture"],
    { cwd: path, stdio: "ignore" },
  );
  execFileSync("git", ["remote", "add", "origin", "git@github.com:Org/claude-repo.git"], {
    cwd: path,
    stdio: "ignore",
  });
}

const execSyncFixture: NonNullable<ClaudeSessionDeps["execSync"]> = (cmd) => {
  const remoteMatch = cmd.match(/^git -C '([^']+)' remote get-url origin/);
  if (remoteMatch) {
    if (remoteMatch[1].endsWith("/repo")) return "git@github.com:Org/claude-repo.git\n";
    throw new Error(`not a git fixture: ${remoteMatch[1]}`);
  }

  const worktreeMatch = cmd.match(/^git -C '([^']+)' worktree list --porcelain/);
  if (worktreeMatch) {
    if (worktreeMatch[1].endsWith("/repo")) {
      return `worktree ${worktreeMatch[1]}\nHEAD fixture\nbranch refs/heads/main\n\n`;
    }
    throw new Error(`not a git fixture: ${worktreeMatch[1]}`);
  }

  const tailMatch = cmd.match(/^tail -100 '([^']+)'/);
  if (tailMatch) return readFileSync(tailMatch[1], "utf-8").split("\n").slice(-100).join("\n");

  const lineCountMatch = cmd.match(/^awk 'END \{ print NR \}' '([^']+)'/);
  if (lineCountMatch) {
    return `${readFileSync(lineCountMatch[1], "utf-8").split("\n").filter(Boolean).length}\n`;
  }

  throw new Error(`unexpected fixture exec: ${cmd}`);
};

beforeEach(() => {
  __resetClaudeSessionCachesForTests();
  process.env.MAW_CLAUDE_SKIP_PID_SCAN = "1";
});

afterEach(() => {
  __resetClaudeSessionCachesForTests();
  restoreEnv();
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("Claude session discovery default-suite coverage", () => {
  test("decodeProjectDir mirrors Claude's path encoding", () => {
    expect(decodeProjectDir("plain-name")).toBe("plain-name");
    expect(decodeProjectDir("-opt-Code-repo")).toBe("/opt/Code/repo");
  });

  test("missing project root is fail-soft and deterministic when PID scan is disabled", async () => {
    process.env.MAW_CLAUDE_PROJECTS_DIR = join(tempPath("missing"), "projects");
    await expect(listClaudeSessions({ execSync: execSyncFixture })).resolves.toEqual([]);
  });

  test("scans recent JSONL sessions, extracts git metadata and messages, filters stale/noisy entries, and caches results", async () => {
    const root = tempPath("root");
    const projectsRoot = join(root, "claude", "projects");
    const repoPath = join(root, "repo");
    const nonGitProject = join(root, "nogit");
    initGitRepo(repoPath);
    mkdirSync(nonGitProject, { recursive: true });
    process.env.MAW_CLAUDE_PROJECTS_DIR = projectsRoot;

    const userMessage = "user ".repeat(60);
    const assistantMessage = "assistant ".repeat(40);
    const newestBody = [
      JSON.stringify({ type: "user", message: { content: "older user" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: assistantMessage }] },
      }),
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: userMessage }] } }),
      "{malformed json",
    ].join("\n");
    writeSession(projectsRoot, repoPath, "newest", 1_000, newestBody);
    writeSession(projectsRoot, nonGitProject, "older", 5_000, "");

    const noisyDir = join(projectsRoot, encodeProjectPath(nonGitProject));
    writeFileSync(join(noisyDir, "older-subagents.jsonl"), "ignored");
    writeFileSync(join(noisyDir, "notes.txt"), "ignored");
    const stale = join(noisyDir, "stale.jsonl");
    writeFileSync(stale, "too old");
    const old = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(stale, old, old);
    symlinkSync("/definitely/missing", join(noisyDir, "missing-stat.jsonl"));
    writeFileSync(join(projectsRoot, "-not-a-directory"), "forces readdir failure");
    writeFileSync(join(projectsRoot, "plain-name"), "filtered before readdir");

    const sessions = await listClaudeSessions({ execSync: execSyncFixture });
    const cached = await listClaudeSessions({ execSync: execSyncFixture });

    expect(cached).toBe(sessions);
    expect(sessions.map((s) => s.sessionId)).toEqual(["newest", "older"]);
    expect(sessions[0]).toMatchObject({
      projectPath: repoPath,
      repo: "github.com/Org/claude-repo",
      worktree: { name: repoPath.split("/").pop(), branch: "main" },
      pid: null,
      ppid: null,
      parentChain: [],
      tmuxTarget: null,
      triggeredFrom: "unknown",
      status: "ended",
      lastUserMessage: userMessage.slice(0, 200),
      lastAssistantMessage: assistantMessage.slice(0, 200),
      messageCount: 4,
    });
    expect(sessions[0].sizeBytes).toBeGreaterThan(0);
    expect(sessions[0].lastActivityAt).toMatch(/T/);
    expect(sessions[1]).toMatchObject({
      projectPath: nonGitProject,
      repo: null,
      worktree: null,
      lastUserMessage: null,
      lastAssistantMessage: null,
      messageCount: 0,
    });
  });
});
