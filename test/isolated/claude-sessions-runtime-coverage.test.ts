/**
 * Runtime coverage for Claude session discovery. A single isolated module import
 * drives pid discovery/cache, trigger classification, git metadata, tail parsing,
 * project scanning fallbacks, and session cache behavior without touching local
 * Claude/tmux/git state.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";

const created: string[] = [];
const originalProjectsDir = process.env.MAW_CLAUDE_PROJECTS_DIR;
const originalSkipPidScan = process.env.MAW_CLAUDE_SKIP_PID_SCAN;
const originalPlatform = process.platform;
const originalDateNow = Date.now;

let homeDir = "/tmp/mawhome";
let execCalls: string[] = [];
let execSyncImpl: (cmd: string) => string = () => "";
let now = originalDateNow();

mock.module(import.meta.resolve("os"), () => ({
  homedir: () => homeDir,
}));

mock.module(import.meta.resolve("child_process"), () => ({
  execSync: (cmd: string) => {
    execCalls.push(cmd);
    return execSyncImpl(cmd);
  },
}));

const { decodeProjectDir, listClaudeSessions } = await import("../../src/core/fleet/claude-sessions.ts?claude-sessions-runtime-coverage");

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function tempDir(): string {
  // Claude's dash encoding is lossy for "." and "-" path segments; use a
  // stable dot-free temp root so TMPDIR=tmp.XXXX coverage runs do not change
  // decoded project paths and pid cwd matching.
  const dir = mkdtempSync(join(realpathSync("/tmp"), "mawclauderuntime"));
  created.push(dir);
  return dir;
}

function encodeProjectPath(path: string): string {
  return path.replace(/^\//, "-").replace(/[/.]/g, "-");
}

function writeSession(projectsRoot: string, projectPath: string, sessionId: string, ageMs = 1_000) {
  const dir = join(projectsRoot, encodeProjectPath(projectPath));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, `${sessionId}\n`);
  const d = new Date(now - ageMs);
  utimesSync(file, d, d);
  return file;
}

beforeEach(() => {
  execCalls = [];
  execSyncImpl = () => "";
  homeDir = tempDir();
  now = 1_000_000_000_000;
  Date.now = () => now;
  if (originalProjectsDir === undefined) delete process.env.MAW_CLAUDE_PROJECTS_DIR;
  else process.env.MAW_CLAUDE_PROJECTS_DIR = originalProjectsDir;
  if (originalSkipPidScan === undefined) delete process.env.MAW_CLAUDE_SKIP_PID_SCAN;
  else process.env.MAW_CLAUDE_SKIP_PID_SCAN = originalSkipPidScan;
  setPlatform("linux");
});

afterEach(() => {
  Date.now = originalDateNow;
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  if (originalProjectsDir === undefined) delete process.env.MAW_CLAUDE_PROJECTS_DIR;
  else process.env.MAW_CLAUDE_PROJECTS_DIR = originalProjectsDir;
  if (originalSkipPidScan === undefined) delete process.env.MAW_CLAUDE_SKIP_PID_SCAN;
  else process.env.MAW_CLAUDE_SKIP_PID_SCAN = originalSkipPidScan;
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("claude-sessions runtime discovery", () => {
  test("covers pid scanning, cache, project scanning, triggers, git metadata, tail parsing, sorting, and session cache", async () => {
    expect(decodeProjectDir("plain-name")).toBe("plain-name");
    expect(decodeProjectDir("-opt-Code-repo")).toBe("/opt/Code/repo");

    // Non-linux pid discovery path + pid cache, with project dir fallback.
    setPlatform("darwin");
    delete process.env.MAW_CLAUDE_PROJECTS_DIR;
    const lsofProject = join(homeDir, "projectfromlsof");
    let psCalls = 0;
    execSyncImpl = (cmd) => {
      if (cmd.startsWith("ps -eo pid,ppid,command")) {
        psCalls += 1;
        return "201 1 claude --darwin";
      }
      if (cmd.startsWith("lsof -p 201")) return `n${lsofProject}\n`;
      throw new Error(`unexpected command: ${cmd}`);
    };
    await expect(listClaudeSessions()).resolves.toEqual([]);
    now += 1_000;
    await expect(listClaudeSessions()).resolves.toEqual([]);
    expect(psCalls).toBe(1);
    expect(execCalls.filter((cmd) => cmd.startsWith("lsof -p 201"))).toHaveLength(1);

    // Explicit skip flag bypasses pid scanning entirely.
    execCalls = [];
    process.env.MAW_CLAUDE_SKIP_PID_SCAN = "1";
    process.env.MAW_CLAUDE_PROJECTS_DIR = join(tempDir(), "missingprojects");
    execSyncImpl = (cmd) => { throw new Error(`should not exec: ${cmd}`); };
    await expect(listClaudeSessions()).resolves.toEqual([]);
    expect(execCalls).toEqual([]);
    delete process.env.MAW_CLAUDE_SKIP_PID_SCAN;

    // ps failure is tolerated and cached while project dir is absent.
    now += 5_100;
    let failingPsCalls = 0;
    execSyncImpl = (cmd) => {
      if (cmd.startsWith("ps -eo pid,ppid,command")) {
        failingPsCalls += 1;
        throw new Error("ps unavailable");
      }
      throw new Error(`unexpected command: ${cmd}`);
    };
    await expect(listClaudeSessions()).resolves.toEqual([]);
    now += 1_000;
    await expect(listClaudeSessions()).resolves.toEqual([]);
    expect(failingPsCalls).toBe(1);

    // Full Linux discovery matrix after pid cache expiry.
    now += 5_100;
    setPlatform("linux");
    execCalls = [];
    const root = tempDir();
    const projectsRoot = join(root, "claude", "projects");
    process.env.MAW_CLAUDE_PROJECTS_DIR = projectsRoot;

    const paths = {
      maw: join(root, "work", "mawproject"),
      tmux: join(root, "work", "tmuxproject"),
      cron: join(root, "work", "cronproject"),
      desktop: join(root, "work", "desktopproject"),
      unknown: join(root, "work", "unknownproject"),
      broken: join(root, "work", "brokenparent"),
      ended: join(root, "work", "endedproject"),
    };
    for (const p of Object.values(paths)) mkdirSync(p, { recursive: true });

    const mawFile = writeSession(projectsRoot, paths.maw, "maw-session", 1_000);
    const tmuxFile = writeSession(projectsRoot, paths.tmux, "tmux-session", 300_000);
    writeSession(projectsRoot, paths.cron, "cron-session", 2_000);
    writeSession(projectsRoot, paths.desktop, "desktop-session", 3_000);
    writeSession(projectsRoot, paths.unknown, "unknown-session", 4_000);
    writeSession(projectsRoot, paths.broken, "broken-session", 5_000);
    writeSession(projectsRoot, paths.ended, "ended-session", 6_000);

    const endedDir = join(projectsRoot, encodeProjectPath(paths.ended));
    writeFileSync(join(endedDir, "notes.txt"), "ignored");
    writeFileSync(join(endedDir, "ended-session-subagents.jsonl"), "ignored");
    const oldFile = join(endedDir, "old-session.jsonl");
    writeFileSync(oldFile, "old");
    const old = new Date(now - 2 * 86_400_000);
    utimesSync(oldFile, old, old);
    symlinkSync("/definitely/missing", join(endedDir, "missing-stat.jsonl"));
    writeFileSync(join(projectsRoot, "-notadirectory"), "forces readdir catch");
    writeFileSync(join(projectsRoot, "plain-name"), "filtered because it does not start with dash");

    execSyncImpl = (cmd) => {
      if (cmd.startsWith("ps -eo pid,ppid,command")) {
        return [
          "101 200 claude --maw",
          "not a parseable ps row",
          "999 1 grep claude",
          "102 300 claude --tmux",
          "103 400 claude --cron",
          "104 500 claude --desktop",
          "105 600 claude --unknown",
          "106 700 claude --broken-parent",
          "107 800 claude --cwd-missing",
        ].join("\n");
      }
      if (cmd.startsWith("readlink /proc/101/cwd")) return `${paths.maw}\n`;
      if (cmd.startsWith("readlink /proc/102/cwd")) return `${paths.tmux}\n`;
      if (cmd.startsWith("readlink /proc/103/cwd")) return `${paths.cron}\n`;
      if (cmd.startsWith("readlink /proc/104/cwd")) return `${paths.desktop}\n`;
      if (cmd.startsWith("readlink /proc/105/cwd")) return `${paths.unknown}\n`;
      if (cmd.startsWith("readlink /proc/106/cwd")) return `${paths.broken}\n`;
      if (cmd.startsWith("readlink /proc/107/cwd")) throw new Error("cwd gone");
      if (cmd.includes("ps -o comm=,ppid= -p 200")) return "maw wake 1";
      if (cmd.includes("ps -o comm=,ppid= -p 300")) return "tmux 1";
      if (cmd.includes("ps -o comm=,ppid= -p 400")) return "cron 1";
      if (cmd.includes("ps -o comm=,ppid= -p 500")) return "Dock 1";
      if (cmd.includes("ps -o comm=,ppid= -p 600")) return "zsh 1";
      if (cmd.includes("ps -o comm=,ppid= -p 700")) throw new Error("parent exited");
      if (cmd.includes("remote get-url origin")) {
        if (cmd.includes(paths.maw)) return "git@github.com:Org/mawproject.git\n";
        if (cmd.includes(paths.tmux)) return "https://github.com/Org/tmuxproject.git\n";
        throw new Error("no remote");
      }
      if (cmd.includes("worktree list --porcelain")) {
        if (cmd.includes(paths.maw)) {
          return [
            "worktree /elsewhere",
            "branch refs/heads/main",
            "",
            `worktree ${paths.maw}`,
            "branch refs/heads/feature/maw",
          ].join("\n");
        }
        if (cmd.includes(paths.tmux)) return "worktree /elsewhere\nbranch refs/heads/other";
        throw new Error("not worktree");
      }
      if (cmd.includes("tail -100")) {
        if (cmd.includes(mawFile)) {
          return [
            JSON.stringify({ type: "user", message: { content: "hello from user" } }),
            JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello from assistant" }] } }),
            "{bad json",
          ].join("\n");
        }
        if (cmd.includes(tmuxFile)) {
          return [
            JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "array user" }] } }),
            JSON.stringify({ type: "assistant", message: { content: "assistant string ignored" } }),
          ].join("\n");
        }
        if (cmd.includes("broken-session.jsonl")) throw new Error("tail failed");
        return "";
      }
      throw new Error(`unexpected command: ${cmd}`);
    };

    const sessions = await listClaudeSessions();
    const cached = await listClaudeSessions();
    expect(cached).toBe(sessions);

    expect(sessions.map((s) => s.sessionId)).toEqual([
      "maw-session",
      "cron-session",
      "desktop-session",
      "unknown-session",
      "broken-session",
      "tmux-session",
      "ended-session",
    ]);
    expect(sessions.find((s) => s.sessionId === "maw-session")).toMatchObject({
      projectPath: paths.maw,
      repo: "github.com/Org/mawproject",
      worktree: { name: "mawproject", branch: "feature/maw" },
      pid: 101,
      ppid: 200,
      parentChain: ["maw wake"],
      tmuxTarget: null,
      triggeredFrom: "maw-wake",
      status: "active",
      lastUserMessage: "hello from user",
      lastAssistantMessage: "hello from assistant",
    });
    expect(sessions.find((s) => s.sessionId === "tmux-session")).toMatchObject({
      repo: "github.com/Org/tmuxproject",
      worktree: null,
      pid: 102,
      ppid: 300,
      parentChain: ["tmux"],
      tmuxTarget: "(tmux: tmuxproject)",
      triggeredFrom: "tmux",
      status: "idle",
      lastUserMessage: "array user",
      lastAssistantMessage: null,
    });
    expect(sessions.find((s) => s.sessionId === "cron-session")).toMatchObject({ triggeredFrom: "cron" });
    expect(sessions.find((s) => s.sessionId === "desktop-session")).toMatchObject({ triggeredFrom: "desktop" });
    expect(sessions.find((s) => s.sessionId === "unknown-session")).toMatchObject({ triggeredFrom: "unknown", parentChain: ["zsh"] });
    expect(sessions.find((s) => s.sessionId === "broken-session")).toMatchObject({ triggeredFrom: "unknown", parentChain: [], lastUserMessage: null, lastAssistantMessage: null });
    expect(sessions.find((s) => s.sessionId === "ended-session")).toMatchObject({
      pid: null,
      ppid: null,
      parentChain: [],
      triggeredFrom: "unknown",
      status: "ended",
      repo: null,
      worktree: null,
    });
    expect(execCalls.filter((cmd) => cmd.startsWith("ps -eo"))).toHaveLength(1);
  });
});
