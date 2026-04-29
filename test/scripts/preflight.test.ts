/**
 * preflight.test.ts — tests for scripts/preflight.sh (#911)
 *
 * Covers:
 *   1. Script exists at the documented path
 *   2. Script is executable (chmod +x)
 *   3. --help flag works (doesn't require a build to be present)
 *   4. Smoke check passes on a healthy build
 *   5. Smoke check fails clearly when the build is broken
 *   6. --install flag is wired (rejects missing arg, accepts a plugin name)
 *   7. Unknown args fail with a clear message
 *
 * Strategy: spawn `bash scripts/preflight.sh` as a subprocess against a
 *   *fake* repo root constructed in a tmpdir. The fake repo includes:
 *     - package.json with a `build` script we control
 *     - a stub `dist/maw` binary that we control
 *   This lets us assert on the exact contract without paying a real Bun
 *   build (~5s) per test.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { spawnSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  statSync,
  readFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "preflight.sh");

// ─── fake-repo harness ───────────────────────────────────────────────────────

interface FakeRepo {
  root: string;
  /** Set how the fake `bun run build` behaves. */
  setBuild(behavior: "ok" | "fail"): void;
  /** Set how the fake dist/maw binary behaves for --version / plugin --help. */
  setBinary(behavior: "ok" | "fail-version" | "fail-plugin-help" | "missing"): void;
  /** Run preflight with the given args inside the fake repo. */
  run(args: string[]): { code: number; stdout: string; stderr: string };
}

function makeFakeRepo(): FakeRepo {
  const root = mkdtempSync(join(tmpdir(), "maw-preflight-"));

  // Make it look like a git repo so `git rev-parse --show-toplevel` works.
  spawnSync("git", ["init", "-q"], { cwd: root });

  // Mirror scripts/ from the real repo so preflight.sh can be invoked from here.
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });

  // package.json — `build` script is overwritten per-test.
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fake", version: "0.0.0", scripts: { build: "true" } }, null, 2),
  );

  // Copy the real preflight.sh into the fake repo. We test the actual file.
  const realScript = readFileSync(SCRIPT, "utf-8");
  writeFileSync(join(root, "scripts", "preflight.sh"), realScript);
  chmodSync(join(root, "scripts", "preflight.sh"), 0o755);

  return {
    root,

    setBuild(behavior) {
      // We hijack `bun run build` by writing a `build` script that either
      // creates dist/maw and exits 0, or just exits 1. Since the script
      // calls `bun run build`, we need bun to be available — but we don't
      // need a real build. We replace the `build` npm script with a shell
      // command that touches dist/maw or fails outright.
      const pkg = {
        name: "fake",
        version: "0.0.0",
        scripts: {
          build:
            behavior === "ok"
              ? "bash -c 'cp dist/_stub_maw dist/maw && chmod +x dist/maw'"
              : "bash -c 'echo build broke >&2; exit 1'",
        },
      };
      writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2));
    },

    setBinary(behavior) {
      const stub = join(root, "dist", "_stub_maw");
      let body = "";
      switch (behavior) {
        case "ok":
          body = `#!/usr/bin/env bash
case "$1" in
  --version) echo "v26.4.29-alpha.fake" ;;
  plugin)
    case "$2" in
      --help) echo "usage: maw plugin ..." ;;
      install) echo "installed: $3" ;;
      *) echo "plugin subcommand: $2" ;;
    esac
    ;;
  *) echo "unknown: $@" ; exit 2 ;;
esac
`;
          break;
        case "fail-version":
          body = `#!/usr/bin/env bash
case "$1" in
  --version) echo "boom" >&2; exit 7 ;;
  *) echo "ok" ;;
esac
`;
          break;
        case "fail-plugin-help":
          body = `#!/usr/bin/env bash
case "$1" in
  --version) echo "v26.4.29-alpha.fake" ;;
  plugin) exit 9 ;;
  *) echo "ok" ;;
esac
`;
          break;
        case "missing":
          // No stub written → build won't produce dist/maw.
          return;
      }
      writeFileSync(stub, body);
      chmodSync(stub, 0o755);
    },

    run(args) {
      const r = spawnSync("bash", ["scripts/preflight.sh", ...args], {
        cwd: root,
        encoding: "utf-8",
        timeout: 30_000,
        env: { ...process.env, NO_COLOR: "1" },
      });
      return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("scripts/preflight.sh — file presence", () => {
  test("script exists at documented path", () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  test("script is executable (chmod +x)", () => {
    const mode = statSync(SCRIPT).mode;
    // Owner-execute bit must be set.
    expect(mode & 0o100).toBe(0o100);
  });

  test("npm script `preflight` is wired in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
    expect(pkg.scripts?.preflight).toBe("bash scripts/preflight.sh");
  });
});

describe("scripts/preflight.sh — smoke", () => {
  test("--help prints usage and exits 0", () => {
    const repo = makeFakeRepo();
    const r = repo.run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("usage");
  });

  test("passes on a healthy build (build OK + binary OK)", () => {
    const repo = makeFakeRepo();
    repo.setBinary("ok");
    repo.setBuild("ok");
    const r = repo.run([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Local-build OK; safe to push");
  });

  test("fails clearly when build is broken", () => {
    const repo = makeFakeRepo();
    repo.setBinary("ok");
    repo.setBuild("fail");
    const r = repo.run([]);
    expect(r.code).not.toBe(0);
    // The FAIL line goes to stderr.
    expect(r.stderr).toContain("FAIL");
    expect(r.stderr.toLowerCase()).toContain("build");
  });

  test("fails clearly when build produces no dist/maw", () => {
    const repo = makeFakeRepo();
    repo.setBinary("missing"); // no stub
    repo.setBuild("ok"); // build "succeeds" but cp will fail since stub doesn't exist
    const r = repo.run([]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("FAIL");
  });

  test("fails clearly when --version smoke fails", () => {
    const repo = makeFakeRepo();
    repo.setBinary("fail-version");
    repo.setBuild("ok");
    const r = repo.run([]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("FAIL");
    expect(r.stderr).toContain("--version");
  });
});

describe("scripts/preflight.sh — flags", () => {
  test("--install requires a plugin name (rejects missing arg)", () => {
    const repo = makeFakeRepo();
    const r = repo.run(["--install"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("FAIL");
    expect(r.stderr).toContain("--install");
  });

  test("--install <name> runs the install round-trip and passes when binary OK", () => {
    const repo = makeFakeRepo();
    repo.setBinary("ok"); // stub handles `plugin install shellenv` → exit 0
    repo.setBuild("ok");
    const r = repo.run(["--install", "shellenv"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("plugin install round-trip OK");
    expect(r.stdout).toContain("shellenv");
    expect(r.stdout).toContain("Local-build OK; safe to push");
  });

  test("unknown arg fails with a clear message", () => {
    const repo = makeFakeRepo();
    const r = repo.run(["--no-such-flag"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("FAIL");
    expect(r.stderr).toContain("unknown");
  });
});
