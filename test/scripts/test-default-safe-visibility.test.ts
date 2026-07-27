/**
 * test-default-safe-visibility.test.ts — tests for scripts/test-default-safe.sh (kobo-476)
 * @maw-test-isolate @maw-test-isolate-cwd-neutral
 *
 * kobo-472 found CI never discovered 42+ src/ test files. kobo-476 found the
 * underlying issue is bigger: `set -e` means ANY case failing (the shared
 * sweep, or any mock.module()-isolated file mid-loop) makes every case still
 * queued after it vanish from the output with zero trace — no skip line, no
 * name, no count. The fix (a report printed by an EXIT trap) only produces
 * output on the failure path, so it could silently regress with no
 * green-path test ever catching it. This file is that test.
 *
 * Capability under test: when a case never gets a turn, ITS FILENAME appears
 * somewhere in the output. NOT under test: the exact wording of the report
 * line — kobo-426 already scarred us once locking a literal string
 * (`margin:4px 0;`) that then went red on an unrelated, capability-preserving
 * change. Assert on the filename, not the sentence around it.
 *
 * Strategy: spawn `bash scripts/test-default-safe.sh` against a *fake* repo
 * built in a tmpdir (git init + tracked fixture test files), same harness
 * shape as test/scripts/preflight.test.ts. We test the actual script file.
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "test-default-safe.sh");

const passBody = (name: string) =>
  `import { test, expect } from "bun:test";\ntest(${JSON.stringify(name)}, () => { expect(1).toBe(1); });\n`;
const failBody = (name: string) =>
  `import { test, expect } from "bun:test";\ntest(${JSON.stringify(name)}, () => { expect(1).toBe(2); });\n`;
const mockPassBody = (name: string) =>
  `import { test, expect, mock } from "bun:test";\nmock.module("node:os", () => ({ hostname: () => "fake" }));\ntest(${JSON.stringify(name)}, () => { expect(1).toBe(1); });\n`;
const mockFailBody = (name: string) =>
  `import { test, expect, mock } from "bun:test";\nmock.module("node:os", () => ({ hostname: () => "fake" }));\ntest(${JSON.stringify(name)}, () => { expect(1).toBe(2); });\n`;

function makeFakeRepo() {
  const root = mkdtempSync(join(tmpdir(), "maw-tds-visibility-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });

  // Copy the real script into the fake repo. We test the actual file, same
  // approach as preflight.test.ts.
  const realScript = readFileSync(SCRIPT, "utf-8");
  writeFileSync(join(root, "scripts", "test-default-safe.sh"), realScript);
  spawnSync("chmod", ["+x", join(root, "scripts", "test-default-safe.sh")]);

  return {
    writeTest(filename: string, body: string) {
      writeFileSync(join(root, "test", filename), body);
    },
    // test-default-safe.sh discovers via `git ls-files` — fixture files must
    // be tracked (staged is enough, no commit needed) before a run.
    track() {
      spawnSync("git", ["add", "-A"], { cwd: root });
    },
    run() {
      const r = spawnSync("bash", ["scripts/test-default-safe.sh"], {
        cwd: root,
        encoding: "utf-8",
        timeout: 30_000,
        env: { ...process.env, MAW_TEST_MODE: "1", NO_COLOR: "1" },
      });
      return { code: r.status ?? -1, combined: (r.stdout ?? "") + (r.stderr ?? "") };
    },
  };
}

describe("scripts/test-default-safe.sh — unattempted-case visibility (kobo-476)", () => {
  test("shared sweep fails → every not-yet-run mock file is named", () => {
    const repo = makeFakeRepo();
    repo.writeTest("safe-fails.test.ts", failBody("shared fails"));
    repo.writeTest("mock1.test.ts", mockPassBody("mock1"));
    repo.writeTest("mock2.test.ts", mockPassBody("mock2"));
    repo.track();

    const r = repo.run();

    expect(r.code).not.toBe(0);
    expect(r.combined).toContain("mock1.test.ts");
    expect(r.combined).toContain("mock2.test.ts");
  });

  test("a mid-loop mock file fails → the case still queued after it is named", () => {
    const repo = makeFakeRepo();
    repo.writeTest("safe.test.ts", passBody("shared passes"));
    repo.writeTest("mock1.test.ts", mockPassBody("mock1"));
    repo.writeTest("mock2.test.ts", mockFailBody("mock2 fails"));
    repo.writeTest("mock3.test.ts", mockPassBody("mock3"));
    repo.track();

    const r = repo.run();

    expect(r.code).not.toBe(0);
    expect(r.combined).toContain("mock3.test.ts");
  });

  test("everything green → script exits 0 (no regression from the added reporting)", () => {
    const repo = makeFakeRepo();
    repo.writeTest("safe.test.ts", passBody("shared passes"));
    repo.writeTest("mock1.test.ts", mockPassBody("mock1"));
    repo.writeTest("mock2.test.ts", mockPassBody("mock2"));
    repo.track();

    const r = repo.run();

    expect(r.code).toBe(0);
    expect(r.combined).not.toContain("NEVER RAN");
  });
});
