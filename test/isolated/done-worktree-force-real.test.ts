import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { removeWorktreeViaConfig } from "../../src/commands/shared/done";

const roots: string[] = [];

function sh(command: string, cwd?: string): string {
  return execSync(command, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), "maw-done-force-"));
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("done worktree forced removal", () => {
  test("removes a worktree containing engine scratch and then deletes the merged branch", async () => {
    const { root, reposRoot, mainPath, worktreePath } = setupRepo();
    const fleetDir = join(root, "fleet");
    mkdirSync(fleetDir, { recursive: true });
    writeFileSync(join(fleetDir, "test.json"), JSON.stringify({
      windows: [{ name: "Codex", repo: "Soul-Brews-Studio/maw-js/agents/1-codex" }],
    }));

    const commands: string[] = [];
    const removed = await removeWorktreeViaConfig("codex", reposRoot, {
      fleetDir,
      fleetDirs: [fleetDir],
      branchBase: "alpha",
      hostExec: async (command) => {
        commands.push(command);
        return sh(command);
      },
      logger: { log: () => {}, error: () => {} },
    });

    expect(removed).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
    expect(commands.some(command => /worktree remove .* --force/.test(command))).toBe(true);
    expect(sh("git branch --list feature/codex", mainPath).trim()).toBe("");
  });
});
