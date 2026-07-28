/**
 * test-default-safe-enumerate.test.ts — tests for the kobo-499 enumeration
 * guard added to scripts/test-default-safe.sh.
 *
 * The card's fear: `git ls-files -- ':(top)test/*.ts' ':(top)test/star-star/*.ts'`
 * (written that way here on purpose — a literal double-star-slash inside
 * this block comment would close it early)
 * silently narrows (a typo, a dropped `**`, an extra exclusion) — every file
 * it DOES still match runs and passes, so the script exits 0 exactly like a
 * real green run, with no signal that fewer files were covered than
 * intended. `test-default-safe.sh` now cross-checks that enumeration against
 * an independent `find`-based recount, and separately asserts the case loop
 * actually reached everything it enumerated (CASE_POS vs CASE_NAMES).
 *
 * Strategy (same fake-repo-in-a-tmpdir pattern as preflight.test.ts): a tiny
 * real git repo with a handful of trivial `.test.ts` fixture files, the REAL
 * test-default-safe.sh copied in verbatim (we test the actual file, not a
 * re-implementation). The happy-path fixture files are deliberately trivial
 * (`test("x", () => {})`, no mock.module, no tmux/exec) so the one `bun test`
 * invocation this triggers is fast and touches nothing real — this is NOT
 * the forbidden full-suite run (that's the live repo's 287-file default
 * suite under the current STOP); it's 2-3 files this test itself controls.
 *
 * The mismatch case never reaches `bun test` at all — the cross-check exits
 * before any run_bun_case call, so it's safe regardless of the STOP.
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "test-default-safe.sh");

function makeFakeRepo(fileCount: number): { root: string; testFiles: string[] } {
  const root = mkdtempSync(join(tmpdir(), "maw-test-default-safe-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "fake@test"], { cwd: root });
  spawnSync("git", ["config", "user.name", "fake"], { cwd: root });

  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });

  const realScript = readFileSync(SCRIPT, "utf-8");
  writeFileSync(join(root, "scripts", "test-default-safe.sh"), realScript);
  chmodSync(join(root, "scripts", "test-default-safe.sh"), 0o755);

  const testFiles: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    const relPath = `test/fixture-${i}.test.ts`;
    writeFileSync(join(root, relPath), `import { test, expect } from "bun:test";\ntest("fixture ${i}", () => { expect(1).toBe(1); });\n`);
    testFiles.push(relPath);
  }

  spawnSync("git", ["add", "-A"], { cwd: root });

  return { root, testFiles };
}

function run(root: string) {
  const r = spawnSync("bash", ["scripts/test-default-safe.sh"], {
    cwd: root,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("kobo-499 — test-default-safe.sh enumerates before running and cross-checks against an independent recount", () => {
  test("happy path: git-ls-files matches an independent find recount — declares the count BEFORE running, and confirms completed==enumerated at the end", () => {
    const { root } = makeFakeRepo(3);
    const { code, stdout, stderr } = run(root);
    rmSync(root, { recursive: true, force: true });

    expect(code).toBe(0);
    // AC1: declared before running the first file — this line must appear
    // BEFORE the "shared default sweep" line that triggers the actual run.
    const enumerateIdx = stdout.indexOf("enumerated 3 default-suite test file(s)");
    const sweepIdx = stdout.indexOf("shared default sweep");
    expect(enumerateIdx).toBeGreaterThan(-1);
    expect(sweepIdx).toBeGreaterThan(-1);
    expect(enumerateIdx).toBeLessThan(sweepIdx);
    // AC: declared vs completed, from the same source, confirmed at the end.
    expect(stdout).toContain("completed 1/1 case(s) — matches enumerated");
    expect(stderr).not.toContain("disagrees with an independent find-based recount");
  });

  test("AC3 mutation: a test file present in git's index but missing from disk (a narrowed/stale enumeration) is caught BEFORE anything runs, names the missing file, and never reaches bun test", () => {
    const { root, testFiles } = makeFakeRepo(3);
    // Simulate exactly the feared failure mode: the enumeration source
    // (git's index, standing in for the pathspec match) still claims a file
    // that the independent recount (the real filesystem, standing in for
    // `find`) no longer sees — remove it from disk WITHOUT `git rm`, so
    // git's index is untouched (mirrors a pathspec silently no longer
    // matching a file that's still really there — the disagreement is what
    // gets caught, not the specific cause).
    rmSync(join(root, testFiles[1]!));

    const { code, stdout, stderr } = run(root);
    rmSync(root, { recursive: true, force: true });

    expect(code).not.toBe(0);
    expect(stderr).toContain("disagrees with an independent find-based recount");
    expect(stderr).toContain(testFiles[1]);
    // Never reached the run step — the cross-check must fire before any
    // bun test invocation, not after.
    expect(stdout).not.toContain("shared default sweep");
    expect(stdout).not.toContain("enumerated");
  });

  test("AC4: the added happy-path output is a short declare+confirm, not a per-file dump", () => {
    const { root } = makeFakeRepo(3);
    const { stdout } = run(root);
    rmSync(root, { recursive: true, force: true });

    const addedLines = stdout.split("\n").filter((l) => l.includes("test-default-safe.sh:"));
    // enumerated + shared sweep + completed — 3 short summary lines, never
    // one line per enumerated file (which would scale with suite size).
    expect(addedLines.length).toBeLessThanOrEqual(4);
  });
});
