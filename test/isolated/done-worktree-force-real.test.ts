import { afterEach, describe, expect, mock, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const roots: string[] = [];
let fleetDirs: string[] = [];
let hostExecCommands: string[] = [];

function sh(command: string, cwd?: string): string {
  return execSync(command, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

mock.module("maw-js/sdk", () => ({
  hostExec: async (command: string) => {
    hostExecCommands.push(command);
    return sh(command);
  },
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  fleetDirsForRead: () => fleetDirs,
}));

const { removeWorktreeViaConfig } = await import(
  "../../src/vendor/mpr-plugins/done/done-worktree.ts?done-worktree-force-real"
);

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), "maw-done-vendor-force-"));
  roots.push(root);

  const reposRoot = join(root, "github.com");
  const mainPath = join(reposRoot, "Soul-Brews-Studio", "maw-js");
  const worktreePath = join(mainPath, "agents", "1-codex");
  mkdirSync(mainPath, { recursive: true });

  sh("git init -q", mainPath);
  sh("git config user.email test@example.com", mainPath);
  sh("git config user.name 'Maw Test'", mainPath);
  writeFileSync(join(mainPath, ".gitignore"), "agents/\n");
  writeFileSync(join(mainPath, "README.md"), "main\n");
  sh("git add README.md .gitignore && git commit -q -m init", mainPath);
  sh("git branch alpha", mainPath);
  sh("git branch feature/codex", mainPath);
  sh(`git worktree add -q '${worktreePath}' feature/codex`, mainPath);

  mkdirSync(join(worktreePath, ".omx", "state"), { recursive: true });
  writeFileSync(join(worktreePath, ".omx", "state", "scratch.json"), "{}\n");

  return { root, reposRoot, mainPath, worktreePath };
}

async function silenceConsole(fn: () => Promise<unknown>) {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

afterEach(() => {
  fleetDirs = [];
  hostExecCommands = [];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("vendor done worktree forced removal", () => {
  test("refuses a configured worktree containing engine scratch without --force", async () => {
    const { root, reposRoot, mainPath, worktreePath } = setupRepo();
    const fleetDir = join(root, "fleet");
    mkdirSync(fleetDir, { recursive: true });
    writeFileSync(join(fleetDir, "test.json"), JSON.stringify({
      windows: [{ name: "Codex", repo: "Soul-Brews-Studio/maw-js/agents/1-codex" }],
    }));
    fleetDirs = [fleetDir];
    writeFileSync(join(worktreePath, "README.md"), "dirty local edit\n");

    await expect(silenceConsole(() =>
      removeWorktreeViaConfig("codex", reposRoot, {}, { branchBase: "alpha" }),
    )).rejects.toThrow("has uncommitted changes; rerun maw done --force");

    expect(existsSync(worktreePath)).toBe(true);
    expect(hostExecCommands.some(command => /worktree remove .* --force/.test(command))).toBe(false);
    expect(sh("git branch --list feature/codex", mainPath).trim()).toContain("feature/codex");
  });

  test("removes a configured worktree containing engine scratch with explicit --force", async () => {
    const { root, reposRoot, mainPath, worktreePath } = setupRepo();
    const fleetDir = join(root, "fleet");
    mkdirSync(fleetDir, { recursive: true });
    writeFileSync(join(fleetDir, "test.json"), JSON.stringify({
      windows: [{ name: "Codex", repo: "Soul-Brews-Studio/maw-js/agents/1-codex" }],
    }));
    fleetDirs = [fleetDir];

    const removed = await silenceConsole(() =>
      removeWorktreeViaConfig("codex", reposRoot, {}, { branchBase: "alpha", force: true }),
    );

    expect(removed).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
    expect(hostExecCommands.some(command => /worktree remove .* --force/.test(command))).toBe(true);
    expect(sh("git branch --list feature/codex", mainPath).trim()).toBe("");
  });
});
