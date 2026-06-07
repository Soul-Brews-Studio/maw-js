import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";

const tempDirs: string[] = [];
const originalProjectsDir = process.env.MAW_CLAUDE_PROJECTS_DIR;
const originalSkipPidScan = process.env.MAW_CLAUDE_SKIP_PID_SCAN;

function tempDir(): string {
  // Claude's project directory encoding is lossy for "." and "-" path
  // segments; keep this fixture under a stable dot-free temp root so the
  // expected decoded project path is deterministic even when TMPDIR is
  // `tmp.XXXX` during coverage runs.
  const dir = mkdtempSync(join(realpathSync("/tmp"), "mawclaudesessions"));
  tempDirs.push(dir);
  return dir;
}

function encodeProjectPath(path: string): string {
  return path.replace(/^\//, "-").replace(/[/.]/g, "-");
}

async function freshModule(): Promise<typeof import("../src/core/fleet/claude-sessions")> {
  return import(`../src/core/fleet/claude-sessions.ts?test=${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  if (originalProjectsDir === undefined) delete process.env.MAW_CLAUDE_PROJECTS_DIR;
  else process.env.MAW_CLAUDE_PROJECTS_DIR = originalProjectsDir;
  if (originalSkipPidScan === undefined) delete process.env.MAW_CLAUDE_SKIP_PID_SCAN;
  else process.env.MAW_CLAUDE_SKIP_PID_SCAN = originalSkipPidScan;
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Claude Code session discovery", () => {
  test("decodeProjectDir reverses Claude's dash path encoding and leaves plain names alone", async () => {
    const { decodeProjectDir } = await freshModule();

    expect(decodeProjectDir("-opt-Code-repo")).toBe("/opt/Code/repo");
    expect(decodeProjectDir("plain-name")).toBe("plain-name");
  });

  test("listClaudeSessions reads recent JSONL sessions from HOME without exposing old or subagent files", async () => {
    const home = tempDir();
    const projectsRoot = join(home, ".claude", "projects");
    process.env.MAW_CLAUDE_PROJECTS_DIR = projectsRoot;
    process.env.MAW_CLAUDE_SKIP_PID_SCAN = "1";
    const projectPath = join(home, "projects", "mawrepo");
    mkdirSync(projectPath, { recursive: true });

    const encoded = encodeProjectPath(projectPath);
    const claudeProjectDir = join(projectsRoot, encoded);
    mkdirSync(claudeProjectDir, { recursive: true });

    const freshSession = join(claudeProjectDir, "session-1.jsonl");
    writeFileSync(freshSession, [
      JSON.stringify({ type: "user", message: { content: "hello from user" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello from assistant" }] } }),
      "{bad json",
    ].join("\n"));

    const oldSession = join(claudeProjectDir, "old-session.jsonl");
    writeFileSync(oldSession, JSON.stringify({ type: "user", message: { content: "too old" } }));
    const old = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(oldSession, old, old);

    writeFileSync(
      join(claudeProjectDir, "session-1-subagents.jsonl"),
      JSON.stringify({ type: "user", message: { content: "subagent" } }),
    );

    const { listClaudeSessions } = await freshModule();
    const sessions = await listClaudeSessions({
      execSync: (command) => {
        if (command.startsWith("tail ")) return readFileSync(freshSession, "utf-8");
        throw new Error(`unexpected execSync call: ${command}`);
      },
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "session-1",
      projectPath,
      repo: null,
      worktree: null,
      pid: null,
      ppid: null,
      parentChain: [],
      tmuxTarget: null,
      triggeredFrom: "unknown",
      status: "ended",
      lastUserMessage: "hello from user",
      lastAssistantMessage: "hello from assistant",
    });
    expect(sessions[0].sizeBytes).toBeGreaterThan(0);
    expect(Date.parse(sessions[0].lastActivityAt)).not.toBeNaN();
  });


  test("listClaudeSessions correlates an active tmux-launched process and reuses the short-lived cache", async () => {
    const home = tempDir();
    const projectsRoot = join(home, ".claude", "projects");
    process.env.MAW_CLAUDE_PROJECTS_DIR = projectsRoot;
    process.env.MAW_CLAUDE_SKIP_PID_SCAN = "0";

    const projectPath = join(home, "projects", "activerepo");
    mkdirSync(projectPath, { recursive: true });
    const encoded = encodeProjectPath(projectPath);
    const claudeProjectDir = join(projectsRoot, encoded);
    mkdirSync(claudeProjectDir, { recursive: true });

    const sessionFile = join(claudeProjectDir, "active.jsonl");
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "array user" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "array assistant" }] } }),
    ].join("\n"));

    const { listClaudeSessions, __resetClaudeSessionCachesForTests } = await freshModule();
    __resetClaudeSessionCachesForTests();
    const commands: string[] = [];
    const execSync = (command: string) => {
      commands.push(command);
      if (command.startsWith("ps -eo")) return `123 45 claude --dangerously-skip-permissions`;
      if (command.startsWith("readlink /proc/123/cwd")) return `${projectPath}\n`;
      if (command.startsWith("lsof -p 123")) return `n${projectPath}\n`;
      if (command.startsWith("ps -o comm=,ppid= -p 45")) return "tmux 1\n";
      if (command.startsWith("tail ")) return readFileSync(sessionFile, "utf-8");
      if (command.startsWith("awk ")) return "2\n";
      if (command.includes("remote get-url") || command.includes("worktree list")) throw new Error("not a git repo");
      throw new Error(`unexpected execSync call: ${command}`);
    };

    const first = await listClaudeSessions({ execSync });
    const second = await listClaudeSessions({ execSync });

    expect(second).toBe(first);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      sessionId: "active",
      projectPath,
      pid: 123,
      ppid: 45,
      parentChain: ["tmux"],
      triggeredFrom: "tmux",
      status: "active",
      lastUserMessage: "array user",
      lastAssistantMessage: "array assistant",
      messageCount: 2,
      repo: null,
      worktree: null,
    });
    expect(first[0].tmuxTarget).toContain("activerepo");
    expect(commands.filter(c => c.startsWith("ps -eo")).length).toBe(1);
  });

  test("listClaudeSessions returns [] when the Claude projects directory is absent", async () => {
    const home = tempDir();
    process.env.MAW_CLAUDE_PROJECTS_DIR = join(home, ".claude", "projects");
    process.env.MAW_CLAUDE_SKIP_PID_SCAN = "1";
    const { listClaudeSessions } = await freshModule();

    await expect(listClaudeSessions()).resolves.toEqual([]);
  });
});
