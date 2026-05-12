/**
 * Tests for `maw self-update` plugin (#1271).
 *
 * Strategy: impl.ts accepts an injected `Runner` whose `.exec()` returns
 * `{ code, stdout, stderr }`. We mount a fake runner that records the
 * shell command + args for each call and returns canned results in order.
 * This lets us exercise every branch (synced / behind / dirty / dry-run /
 * check / force-stash / detached / branch-mismatch / pull-fails /
 * lockfile-changed) without ever shelling out to git or bun.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runSelfUpdate, resolveCheckoutDir, type Runner, type ExecResult } from "../../src/commands/plugins/self-update/impl";

// ── Test scaffolding ────────────────────────────────────────────────────────

interface FakeCall {
  cmd: string;
  args: string[];
  cwd?: string;
}

function makeFakeCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), "maw-self-update-"));
  // .git just needs to exist (existsSync check); contents don't matter
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

/**
 * Build a runner from a script: a sequence of `[cmdMatcher, result]` pairs.
 * cmdMatcher is the full command string `"git fetch origin alpha"`.
 * Unmatched calls return code 0 with empty stdout/stderr.
 */
function scriptedRunner(
  responses: Record<string, ExecResult>,
  calls: FakeCall[],
): Runner {
  return {
    exec(cmd, args, opts) {
      calls.push({ cmd, args, cwd: opts?.cwd });
      const key = `${cmd} ${args.join(" ")}`.trim();
      if (key in responses) return responses[key]!;
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const FAIL = (stderr = "fail"): ExecResult => ({ code: 1, stdout: "", stderr });

// ── resolveCheckoutDir ──────────────────────────────────────────────────────

describe("resolveCheckoutDir", () => {
  test("walks four levels up from impl.ts dir", () => {
    const fake = "/foo/bar/src/commands/plugins/self-update";
    expect(resolveCheckoutDir(fake)).toBe("/foo/bar");
  });
});

// ── Up-to-date path ─────────────────────────────────────────────────────────

describe("runSelfUpdate — already in sync", () => {
  test("HEAD == origin → ok, exit 0, no pull", async () => {
    const dir = makeFakeCheckout();
    try {
      const calls: FakeCall[] = [];
      const runner = scriptedRunner({
        "git rev-parse --abbrev-ref HEAD": OK("alpha\n"),
        "git status --porcelain": OK(""),
        "git fetch origin alpha": OK(""),
        "git rev-parse HEAD": OK("aaaaaaa\n"),
        "git rev-parse origin/alpha": OK("aaaaaaa\n"),
      }, calls);

      const res = await runSelfUpdate({}, runner, dir);
      expect(res.ok).toBe(true);
      expect(res.exitCode).toBe(0);
      expect(res.output).toContain("already in sync");
      // Must not pull
      expect(calls.some(c => c.cmd === "git" && c.args[0] === "pull")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Behind path — normal pull ───────────────────────────────────────────────

describe("runSelfUpdate — behind origin", () => {
  test("clean + behind → pulls --ff-only + bun link", async () => {
    const dir = makeFakeCheckout();
    try {
      const calls: FakeCall[] = [];
      const runner = scriptedRunner({
        "git rev-parse --abbrev-ref HEAD": OK("alpha\n"),
        "git status --porcelain": OK(""),
        "git fetch origin alpha": OK(""),
        "git rev-parse HEAD": OK("aaaaaaa\n"),
        "git rev-parse origin/alpha": OK("bbbbbbb\n"),
        "git log --oneline aaaaaaa..bbbbbbb": OK("bbbbbbb fix: thing\nccc1234 feat: other"),
        "git pull --ff-only origin alpha": OK("Fast-forward\n"),
        "git diff --name-only aaaaaaa..bbbbbbb": OK("src/foo.ts\nREADME.md\n"),
        "bun link": OK(""),
      }, calls);

      const res = await runSelfUpdate({}, runner, dir);
      expect(res.ok).toBe(true);
      expect(res.exitCode).toBe(0);
      expect(res.output).toContain("behind origin/alpha");
      expect(res.output).toContain("fix: thing");
      expect(res.output).toContain("aaaaaaa → bbbbbbb");
      // Must pull --ff-only
      const pull = calls.find(c => c.cmd === "git" && c.args[0] === "pull");
      expect(pull).toBeDefined();
      expect(pull!.args).toContain("--ff-only");
      // Must NOT run bun install (no lockfile change)
      expect(calls.some(c => c.cmd === "bun" && c.args[0] === "install")).toBe(false);
      // Must run bun link
      expect(calls.some(c => c.cmd === "bun" && c.args[0] === "link")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bun.lock changed → runs bun install --frozen-lockfile", async () => {
    const dir = makeFakeCheckout();
    try {
      const calls: FakeCall[] = [];
      const runner = scriptedRunner({
        "git rev-parse --abbrev-ref HEAD": OK("alpha\n"),
        "git status --porcelain": OK(""),
        "git fetch origin alpha": OK(""),
        "git rev-parse HEAD": OK("aaaaaaa\n"),
        "git rev-parse origin/alpha": OK("bbbbbbb\n"),
        "git log --oneline aaaaaaa..bbbbbbb": OK("bbbbbbb chore: bump"),
        "git pull --ff-only origin alpha": OK("Fast-forward\n"),
        "git diff --name-only aaaaaaa..bbbbbbb": OK("bun.lock\npackage.json\n"),
        "bun install --frozen-lockfile": OK(""),
        "bun link": OK(""),
      }, calls);

      const res = await runSelfUpdate({}, runner, dir);
      expect(res.ok).toBe(true);
      const inst = calls.find(c => c.cmd === "bun" && c.args[0] === "install");
      expect(inst).toBeDefined();
      expect(inst!.args).toContain("--frozen-lockfile");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Dirty refusal ───────────────────────────────────────────────────────────

describe("runSelfUpdate — dirty checkout", () => {
  test("dirty + no --force → refuse with hint", async () => {
    const dir = makeFakeCheckout();
    try {
      const calls: FakeCall[] = [];
      const runner = scriptedRunner({
        "git rev-parse --abbrev-ref HEAD": OK("alpha\n"),
        "git status --porcelain": OK(" M src/foo.ts\n"),
      }, calls);

      const res = await runSelfUpdate({}, runner, dir);
      expect(res.ok).toBe(false);
      expect(res.exitCode).toBe(1);
      expect(res.output).toContain("dirty");
      expect(res.output).toContain("--force");
      // Must not fetch
      expect(calls.some(c => c.cmd === "git" && c.args[0] === "fetch")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dirty + --force → stash, pull, restore", async () => {
    const dir = makeFakeCheckout();
    try {
      const calls: FakeCall[] = [];
      const runner = scriptedRunner({
        "git rev-parse --abbrev-ref HEAD": OK("alpha\n"),
        "git status --porcelain": OK(" M src/foo.ts\n"),
        "git fetch origin alpha": OK(""),
        "git rev-parse HEAD": OK("aaaaaaa\n"),
        "git rev-parse origin/alpha": OK("bbbbbbb\n"),
        "git log --oneline aaaaaaa..bbbbbbb": OK("bbbbbbb fix: thing"),
        "git stash push -u -m maw self-update auto-stash": OK(""),
        "git pull --ff-only origin alpha": OK("Fast-forward\n"),
        "git diff --name-only aaaaaaa..bbbbbbb": OK("src/foo.ts\n"),
        "bun link": OK(""),
        "git stash pop": OK(""),
      }, calls);

      const res = await runSelfUpdate({ force: true }, runner, dir);
      expect(res.ok).toBe(true);
      // Stash push BEFORE pull
      const pushIdx = calls.findIndex(c => c.cmd === "git" && c.args[0] === "stash" && c.args[1] === "push");
      const pullIdx = calls.findIndex(c => c.cmd === "git" && c.args[0] === "pull");
      const popIdx = calls.findIndex(c => c.cmd === "git" && c.args[0] === "stash" && c.args[1] === "pop");
      expect(pushIdx).toBeGreaterThan(-1);
      expect(pullIdx).toBeGreaterThan(pushIdx);
      expect(popIdx).toBeGreaterThan(pullIdx);
      expect(res.output).toContain("stashing");
      expect(res.output).toContain("restored stash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dirty + --force + pull fails → restore stash before exit", async () => {
    const dir = makeFakeCheckout();
    try {
      const calls: FakeCall[] = [];
      const runner = scriptedRunner({
        "git rev-parse --abbrev-ref HEAD": OK("alpha\n"),
        "git status --porcelain": OK(" M src/foo.ts\n"),
        "git fetch origin alpha": OK(""),
        "git rev-parse HEAD": OK("aaaaaaa\n"),
        "git rev-parse origin/alpha": OK("bbbbbbb\n"),
        "git log --oneline aaaaaaa..bbbbbbb": OK("bbbbbbb fix: thing"),
        "git stash push -u -m maw self-update auto-stash": OK(""),
        "git pull --ff-only origin alpha": FAIL("Not possible to fast-forward"),
        "git stash pop": OK(""),
      }, calls);

      const res = await runSelfUpdate({ force: true }, runner, dir);
      expect(res.ok).toBe(false);
      expect(res.output).toContain("pull --ff-only failed");
      // Must have attempted stash pop after pull failure
      expect(calls.some(c => c.cmd === "git" && c.args[0] === "stash" && c.args[1] === "pop")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── --check ─────────────────────────────────────────────────────────────────

describe("runSelfUpdate — --check", () => {
  test("synced → exit 0", async () => {
    const dir = makeFakeCheckout();
    try {
      const calls: FakeCall[] = [];
      const runner = scriptedRunner({
        "git rev-parse --abbrev-ref HEAD": OK("alpha\n"),
        "git status --porcelain": OK(""),
        "git fetch origin alpha": OK(""),
        "git rev-parse HEAD": OK("aaaaaaa\n"),
        "git rev-parse origin/alpha": OK("aaaaaaa\n"),
      }, calls);

      const res = await runSelfUpdate({ check: true }, runner, dir);
      expect(res.ok).toBe(true);
      expect(res.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("behind → exit 1 without pulling", async () => {
    const dir = makeFakeCheckout();
    try {
      const calls: FakeCall[] = [];
      const runner = scriptedRunner({
        "git rev-parse --abbrev-ref HEAD": OK("alpha\n"),
        "git status --porcelain": OK(""),
        "git fetch origin alpha": OK(""),
        "git rev-parse HEAD": OK("aaaaaaa\n"),
        "git rev-parse origin/alpha": OK("bbbbbbb\n"),
        "git log --oneline aaaaaaa..bbbbbbb": OK("bbbbbbb fix: thing\nccc1234 feat: other\n"),
      }, calls);

      const res = await runSelfUpdate({ check: true }, runner, dir);
      expect(res.ok).toBe(false);
      expect(res.exitCode).toBe(1);
      expect(res.output).toContain("2 commits behind");
      // Must NOT pull
      expect(calls.some(c => c.cmd === "git" && c.args[0] === "pull")).toBe(false);
      expect(calls.some(c => c.cmd === "bun" && c.args[0] === "link")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── --dry-run ───────────────────────────────────────────────────────────────

describe("runSelfUpdate — --dry-run", () => {
  test("behind → reports delta, does NOT pull/link", async () => {
    const dir = makeFakeCheckout();
    try {
      const calls: FakeCall[] = [];
      const runner = scriptedRunner({
        "git rev-parse --abbrev-ref HEAD": OK("alpha\n"),
        "git status --porcelain": OK(""),
        "git fetch origin alpha": OK(""),
        "git rev-parse HEAD": OK("aaaaaaa\n"),
        "git rev-parse origin/alpha": OK("bbbbbbb\n"),
        "git log --oneline aaaaaaa..bbbbbbb": OK("bbbbbbb fix: A\nccc1234 fix: B\n"),
      }, calls);

      const res = await runSelfUpdate({ dryRun: true }, runner, dir);
      expect(res.ok).toBe(true);
      expect(res.output).toContain("dry-run");
      expect(res.output).toContain("would pull 2 commits");
      // Must NOT pull or link
      expect(calls.some(c => c.cmd === "git" && c.args[0] === "pull")).toBe(false);
      expect(calls.some(c => c.cmd === "bun")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── --branch ────────────────────────────────────────────────────────────────

describe("runSelfUpdate — --branch", () => {
  test("custom branch → fetches and resolves that branch", async () => {
    const dir = makeFakeCheckout();
    try {
      const calls: FakeCall[] = [];
      const runner = scriptedRunner({
        "git rev-parse --abbrev-ref HEAD": OK("main\n"),
        "git status --porcelain": OK(""),
        "git fetch origin main": OK(""),
        "git rev-parse HEAD": OK("aaaaaaa\n"),
        "git rev-parse origin/main": OK("aaaaaaa\n"),
      }, calls);

      const res = await runSelfUpdate({ branch: "main", check: true }, runner, dir);
      expect(res.ok).toBe(true);
      const fetch = calls.find(c => c.cmd === "git" && c.args[0] === "fetch");
      expect(fetch).toBeDefined();
      expect(fetch!.args).toContain("main");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("local branch != target branch → refuse with hint", async () => {
    const dir = makeFakeCheckout();
    try {
      const calls: FakeCall[] = [];
      const runner = scriptedRunner({
        "git rev-parse --abbrev-ref HEAD": OK("main\n"),
      }, calls);

      const res = await runSelfUpdate({}, runner, dir); // default alpha, local main
      expect(res.ok).toBe(false);
      expect(res.exitCode).toBe(1);
      expect(res.output).toContain("'main'");
      expect(res.output).toContain("'alpha'");
      expect(res.output).toContain("Refusing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Detached HEAD ───────────────────────────────────────────────────────────

describe("runSelfUpdate — detached HEAD", () => {
  test("HEAD → refuse with branch hint", async () => {
    const dir = makeFakeCheckout();
    try {
      const calls: FakeCall[] = [];
      const runner = scriptedRunner({
        "git rev-parse --abbrev-ref HEAD": OK("HEAD\n"),
      }, calls);

      const res = await runSelfUpdate({}, runner, dir);
      expect(res.ok).toBe(false);
      expect(res.exitCode).toBe(1);
      expect(res.output).toContain("detached HEAD");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Not a git checkout ──────────────────────────────────────────────────────

describe("runSelfUpdate — not a git checkout", () => {
  test("missing .git → refuse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-self-update-nogit-"));
    try {
      const calls: FakeCall[] = [];
      const runner = scriptedRunner({}, calls);
      const res = await runSelfUpdate({}, runner, dir);
      expect(res.ok).toBe(false);
      expect(res.exitCode).toBe(1);
      expect(res.output).toContain("not a git checkout");
      // No commands fired
      expect(calls.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Handler dispatch (index.ts) ─────────────────────────────────────────────

describe("self-update handler — dispatch", () => {
  test("--help → returns usage, no side effects", async () => {
    const handler = (await import("../../src/commands/plugins/self-update/index")).default;
    const res = await handler({ source: "cli", args: ["--help"] });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("usage: maw self-update");
    expect(res.output).toContain("--dry-run");
    expect(res.output).toContain("--check");
    expect(res.output).toContain("--branch");
    expect(res.output).toContain("--force");
  });

  test("-h → returns usage", async () => {
    const handler = (await import("../../src/commands/plugins/self-update/index")).default;
    const res = await handler({ source: "cli", args: ["-h"] });
    expect(res.ok).toBe(true);
    expect(res.output).toContain("usage: maw self-update");
  });
});
