import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

import { _test } from "../../src/commands/shared/wake-cmd";

const tempRepos: string[] = [];
let gitAvailable = false;

beforeAll(() => {
  try {
    execSync("git --version", { stdio: "ignore" });
    gitAvailable = true;
  } catch {}
});

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "maw-wake-cmd-win-"));
  tempRepos.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRepos.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("wake-cmd windows path support (T-069)", () => {
  test("repoNameFromPath handles Unix, Windows and trailing slash", () => {
    expect(_test.repoNameFromPath("/gh/Soul-Brews-Studio/neo-oracle")).toBe("neo-oracle");
    expect(_test.repoNameFromPath("/gh/Soul-Brews-Studio/neo-oracle/")).toBe("neo-oracle");
    expect(_test.repoNameFromPath("C:\\gh\\Soul-Brews-Studio\\Neo-Oracle")).toBe("Neo-Oracle");
    expect(_test.repoNameFromPath("single")).toBe("single");
  });

  test("ensureWakeSessionVault creates ψ dir and ignores ψ/ in gitignore", () => {
    const repo = tempRepo();
    _test.ensureWakeSessionVault({ mode: "work" } as any, repo);
    expect(readFileSync(join(repo, ".gitignore"), "utf-8")).toContain("ψ/");
  });

  test("ensureWakeSessionVault skips gitignore when ψ/ is already tracked", () => {
    if (!gitAvailable) return;
    const repo = tempRepo();
    mkdirSync(join(repo, "ψ"), { recursive: true });
    writeFileSync(join(repo, "ψ", "hello.md"), "hi");
    writeFileSync(join(repo, "readme.md"), "repo");
    execSync("git init", { cwd: repo, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: repo, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: repo, stdio: "ignore" });
    execSync("git add .", { cwd: repo, stdio: "ignore" });
    execSync('git commit -m "init"', { cwd: repo, stdio: "ignore" });

    _test.ensureWakeSessionVault({ mode: "work" } as any, repo);
    expect(() => readFileSync(join(repo, ".gitignore"), "utf-8")).toThrow();
  });

  test("ensureWakeSessionVault is a no-op for oracle mode", () => {
    const repo = tempRepo();
    _test.ensureWakeSessionVault({ mode: "oracle" } as any, repo);
    expect(() => readFileSync(join(repo, ".gitignore"), "utf-8")).toThrow();
  });
});
