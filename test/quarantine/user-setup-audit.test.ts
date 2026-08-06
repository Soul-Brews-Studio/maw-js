import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { auditClaudeProjects, inferPathFromEncoded } from "../../src/vendor/mpr-plugins/user-setup/impl";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "maw-user-setup-audit-"));
  roots.push(root);
  return root;
}

function encodeClaudeProjectPath(path: string): string {
  const absolute = resolve(path);
  const normalized = absolute.replace(/\\/g, "/");
  const withDriveMarker = normalized.replace(/^([A-Za-z]):\//, "/$1--");
  return withDriveMarker.replace(/^\//, "-").replace(/\//g, "-");
}

function expectPath(received: string, expected: string) {
  expect(received.replace(/\\/g, "/")).toBe(expected.replace(/\\/g, "/"));
}

function writeJsonl(path: string, lines = 1): void {
  const body = Array.from({ length: lines }, (_, i) => JSON.stringify({ type: "user", message: { content: `m${i}` } })).join("\n") + "\n";
  writeFileSync(path, body);
}

describe("user-setup projects audit", () => {
  test("returns a stable empty result when Claude projects root is missing", async () => {
    const root = join(tempRoot(), "missing", "projects");
    const result = await auditClaudeProjects({ projectsRoot: root, now: () => new Date("2026-05-30T00:00:00Z") });

    expect(result).toEqual({
      root,
      generatedAt: "2026-05-30T00:00:00.000Z",
      projectCount: 0,
      totalSizeBytes: 0,
      entries: [],
      warnings: [expect.stringContaining("cannot read Claude projects dir")],
    });
  });

  test("audits probable existing paths with sessions, nested subagents, largest files, and git remote evidence", async () => {
    const root = tempRoot();
    const sourceRoot = join(tmpdir(), `mawusersetupprobable${process.pid}`);
    roots.push(sourceRoot);
    const source = join(sourceRoot, "src", "plainrepo");
    mkdirSync(source, { recursive: true });
    const encoded = encodeClaudeProjectPath(source);
    const projectDir = join(root, "claude", encoded);
    mkdirSync(join(projectDir, "subagents"), { recursive: true });
    writeJsonl(join(projectDir, "a-session.jsonl"), 2);
    writeJsonl(join(projectDir, "subagents", "nested-session.jsonl"), 1);
    writeFileSync(join(projectDir, "large.txt"), "x".repeat(128));

    const result = await auditClaudeProjects({
      projectsRoot: join(root, "claude"),
      now: () => new Date("2026-05-30T01:02:03Z"),
      cwd: () => "/not/the/source",
      execSync: (cmd) => {
        if (cmd.includes("remote get-url origin")) return "git@github.com:Soul-Brews-Studio/plainrepo.git\n";
        if (cmd.includes("worktree list")) return "";
        return "";
      },
    });

    const isWindows = process.platform === "win32";
    expect(result.projectCount).toBe(1);
    const entry = result.entries[0];
    expect(entry.encoded).toBe(encoded);
    if (isWindows) {
      // Claude project-dir encoding is lossy for dashes; Windows temp dirs often
      // contain hyphenated 8.3 segments, so exact inferred/sourceExists may fail.
      // We still verify the audit reads the project dir and sessions correctly.
    } else {
      expectPath(entry.path.inferred, source);
      expect(entry.path.confidence).toBe("probable");
      expect(entry.path.evidence).toContain("inferred-path-exists");
      expect(entry.sourceExists).toBe(true);
    }
    expect(entry.path.evidence).toContain("dash-decoded-from-claude-project-dir");
    expect(entry.sessionCount).toBe(2);
    expect(entry.sizeBytes).toBeGreaterThan(128);
    if (!isWindows) {
      expect(entry.repo).toEqual({ remote: "github.com/Soul-Brews-Studio/plainrepo", owner: "Soul-Brews-Studio", name: "plainrepo" });
    }
    expect(entry.largestFiles[0]).toMatchObject({ name: "large.txt", sizeBytes: 128 });
    if (!isWindows) {
      expect(entry.warnings).not.toContain("path confidence is ambiguous");
    }
  });

  test("does not overclaim exactness for lossy hyphenated project names", async () => {
    const encoded = "-opt-Code-github.com-Soul-Brews-Studio-maw-js";
    const finding = inferPathFromEncoded(encoded, { existsSync: () => false, cwd: () => "/elsewhere" });

    expect(finding.inferred).toBe("/opt/Code/github.com/Soul/Brews/Studio/maw/js");
    expect(finding.confidence).toBe("ambiguous");
    expect(finding.evidence).toContain("dash-decoded-from-claude-project-dir");
  });

  test("marks non-absolute encoded directories as unknown and flags empty project dirs", async () => {
    const root = tempRoot();
    const projectDir = join(root, "relative-name");
    mkdirSync(projectDir, { recursive: true });

    const result = await auditClaudeProjects({ projectsRoot: root, now: () => new Date("2026-05-30T00:00:00Z") });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].path).toEqual({
      encoded: "relative-name",
      confidence: "unknown",
      evidence: ["encoded-name-does-not-look-like-absolute-claude-project-dir"],
    });
    expect(result.entries[0].warnings).toContain("path confidence is unknown");
    expect(result.entries[0].warnings).toContain("no JSONL sessions found");
  });

  test("surfaces worktree-shaped directories and stat failures without throwing", async () => {
    const root = tempRoot();
    const source = join(root, "agents", "1", "mawjs");
    const encoded = encodeClaudeProjectPath(source);
    const projectDir = join(root, "claude", encoded);
    mkdirSync(projectDir, { recursive: true });
    writeJsonl(join(projectDir, "session.jsonl"));

    const result = await auditClaudeProjects({
      projectsRoot: join(root, "claude"),
      cwd: () => "/elsewhere",
      statSync: (path) => {
        if (String(path).endsWith("session.jsonl")) throw new Error("boom");
        return statSync(path);
      },
    });

    const entry = result.entries[0];
    expect(entry.worktree.detected).toBe(true);
    expect(entry.worktree.evidence).toContain("path-shape-suggests-worktree");
    expect(entry.warnings.some(w => w.includes("stat failed") && w.includes("boom"))).toBe(true);
  });
});

test("top-level user-setup plan only prunes empty missing worktree-derived dirs", async () => {
  const root = tempRoot();
  const projects = join(root, "projects");
  mkdirSync(projects, { recursive: true });

  const pruneMe = "-tmp-repo-wt-1-task";
  mkdirSync(join(projects, pruneMe), { recursive: true });
  const keepMain = "-tmp-missing-main";
  mkdirSync(join(projects, keepMain), { recursive: true });
  const keepMemory = "-tmp-repo-wt-2-memory";
  mkdirSync(join(projects, keepMemory), { recursive: true });
  writeJsonl(join(projects, keepMemory, "session.jsonl"));
  writeJsonl(join(projects, "orphan.jsonl"));

  const { planUserSetupPrune, renderUserSetupPlan } = await import("../../src/vendor/mpr-plugins/user-setup/impl");
  const plan = await planUserSetupPrune({ dryRun: true }, {
    projectsRoot: projects,
    now: () => new Date("2026-06-06T00:00:00Z"),
    cwd: () => "/elsewhere",
  });
  plan.duplicateEncodedPaths.push({ inferred: "/tmp/dupe", encoded: ["-tmp-dupe-a", "-tmp-dupe-b"] });
  const output = renderUserSetupPlan(plan);

  expect(plan.staleProjectDirs.map(e => e.encoded)).toEqual([pruneMe]);
  expect(plan.orphanSessionFiles.map(f => f.name)).toEqual(["orphan.jsonl"]);
  expect(output).toContain("safe prune candidates: 1");
  expect(output).toContain("why: worktree-derived name (-wt-/-agents-), 0 JSONL sessions, decoded path missing");
  expect(output).not.toContain(keepMain);
  expect(output).not.toContain(keepMemory);
  expect(output).toContain("duplicate encoded paths: 1");
  expect(output).toContain("prune offer:");
});
