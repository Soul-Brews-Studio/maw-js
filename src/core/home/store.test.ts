import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  commitHome,
  defaultRepoSlug,
  ensureGitignore,
  homeDir,
  initHome,
  safeSegment,
} from "./store";
import type { RunResult } from "./git";

const dir = mkdtempSync(join(tmpdir(), "maw-home-"));
const prev = process.env.MAW_DATA_DIR;

beforeAll(() => { process.env.MAW_DATA_DIR = dir; });
afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { rmSync(join(dir, "companies"), { recursive: true, force: true }); });

const ok = (stdout = ""): RunResult => ({ ok: true, stdout, stderr: "", status: 0 });
const fail = (stderr: string): RunResult => ({ ok: false, stdout: "", stderr, status: 1 });

/**
 * Programmable fake git: `state` decides isGitRepo / hasOrigin / dirty; every
 * call is recorded so a test can assert the exact command sequence.
 */
function fakeGit(state: { isRepo?: boolean; hasOrigin?: boolean; dirty?: boolean } = {}) {
  const calls: string[][] = [];
  const run = (_cwd: string, args: string[]): RunResult => {
    calls.push(args);
    const k = args.join(" ");
    if (k === "rev-parse --is-inside-work-tree") return ok(state.isRepo ? "true" : "");
    if (k === "remote get-url origin") return state.hasOrigin ? ok("https://github.com/x/y.git") : fail("no origin");
    if (k === "status --porcelain") return ok(state.dirty ? " M tasks/x.json" : "");
    if (args[0] === "init") { state.isRepo = true; return ok(); }
    return ok();
  };
  return { run, calls };
}

describe("home store — pure helpers", () => {
  test("safeSegment / homeDir / defaultRepoSlug", () => {
    expect(safeSegment("ko/bo..x")).toBe("ko_bo__x");
    expect(homeDir("kobo")).toBe(join(dir, "companies", "kobo"));
    expect(defaultRepoSlug("kobo")).toBe("meganechan/maw-home-kobo");
    expect(defaultRepoSlug("kobo", "acme")).toBe("acme/maw-home-kobo");
  });

  test("ensureGitignore creates the file excluding worklog.jsonl; idempotent", () => {
    const d = homeDir("kobo");
    require("fs").mkdirSync(d, { recursive: true });
    expect(ensureGitignore(d)).toBe(true);
    const body = readFileSync(join(d, ".gitignore"), "utf8");
    expect(body).toContain("worklog.jsonl");
    expect(ensureGitignore(d)).toBe(false); // already ignored → no rewrite
  });

  test("ensureGitignore appends to an existing .gitignore without dup", () => {
    const d = homeDir("kobo");
    require("fs").mkdirSync(d, { recursive: true });
    require("fs").writeFileSync(join(d, ".gitignore"), "node_modules\n");
    expect(ensureGitignore(d)).toBe(true);
    const body = readFileSync(join(d, ".gitignore"), "utf8");
    expect(body).toContain("node_modules");
    expect(body).toContain("worklog.jsonl");
  });
});

describe("initHome", () => {
  test("fresh home → init, commit, create PRIVATE repo + push", () => {
    const git = fakeGit({ isRepo: false, hasOrigin: false, dirty: true });
    const ghCalls: string[][] = [];
    const gh = (args: string[]): RunResult => { ghCalls.push(args); return ok(); };

    const r = initHome({ company: "kobo" }, { git: git.run, gh });
    expect(r.ok).toBe(true);
    // .gitignore written, worklog excluded
    expect(existsSync(join(homeDir("kobo"), ".gitignore"))).toBe(true);
    // git sequence
    const seq = git.calls.map((a) => a.join(" "));
    expect(seq).toContain("init -b main");
    expect(seq).toContain("add -A");
    expect(seq.some((s) => s.startsWith("commit -m"))).toBe(true);
    // gh: created a PRIVATE repo from this source and pushed
    expect(ghCalls[0]).toEqual(["repo", "create", "meganechan/maw-home-kobo", "--private", "--source", homeDir("kobo"), "--remote", "origin", "--push"]);
    expect(r.steps.some((s) => s.includes("PRIVATE repo"))).toBe(true);
  });

  test("custom org/repo/branch flow through to slug + init", () => {
    const git = fakeGit({ dirty: true });
    const ghCalls: string[][] = [];
    const r = initHome({ company: "kobo", org: "acme", repo: "acme/custom", branch: "trunk" }, { git: git.run, gh: (a) => { ghCalls.push(a); return ok(); } });
    expect(r.ok).toBe(true);
    expect(git.calls.map((a) => a.join(" "))).toContain("init -b trunk");
    expect(ghCalls[0]).toContain("acme/custom"); // explicit --repo wins over --org default
  });

  test("idempotent: existing repo + origin → push only, no gh create", () => {
    const git = fakeGit({ isRepo: true, hasOrigin: true, dirty: false });
    let ghCalled = false;
    const r = initHome({ company: "kobo" }, { git: git.run, gh: () => { ghCalled = true; return ok(); } });
    expect(r.ok).toBe(true);
    expect(ghCalled).toBe(false);
    expect(git.calls.map((a) => a.join(" "))).toContain("push -u origin main");
    expect(git.calls.map((a) => a.join(" ")).some((s) => s.startsWith("init"))).toBe(false);
  });

  test("repo already exists on GitHub → link remote + push", () => {
    const git = fakeGit({ isRepo: false, hasOrigin: false, dirty: true });
    const r = initHome({ company: "kobo" }, { git: git.run, gh: () => fail("GraphQL: Name already exists on this account") });
    expect(r.ok).toBe(true);
    const seq = git.calls.map((a) => a.join(" "));
    expect(seq.some((s) => s.startsWith("remote add origin"))).toBe(true);
    expect(seq).toContain("push -u origin main");
  });

  test("permission error → friendly org-admin message", () => {
    const git = fakeGit({ dirty: true });
    const r = initHome({ company: "kobo" }, { git: git.run, gh: () => fail("HTTP 403: must be an admin") });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no permission");
  });

  test("git init failure → surfaced error", () => {
    const git = (_c: string, args: string[]): RunResult => {
      if (args[0] === "rev-parse") return ok("");
      if (args[0] === "init") return fail("fatal: cannot init");
      return ok();
    };
    const r = initHome({ company: "kobo" }, { git, gh: () => ok() });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("git init failed");
  });
});

describe("commitHome", () => {
  test("not initialized → clear error", () => {
    const git = fakeGit({ isRepo: false });
    const r = commitHome({ company: "kobo" }, { git: git.run });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("home init");
  });

  test("nothing to commit → benign success (clean home)", () => {
    require("fs").mkdirSync(homeDir("kobo"), { recursive: true });
    const git = fakeGit({ isRepo: true, dirty: false });
    const r = commitHome({ company: "kobo" }, { git: git.run });
    expect(r.ok).toBe(true);
    expect(r.steps.join(" ")).toContain("nothing to commit");
    expect(git.calls.map((a) => a.join(" ")).some((s) => s.startsWith("commit"))).toBe(false);
  });

  test("dirty home → commit with injected timestamp + push", () => {
    require("fs").mkdirSync(homeDir("kobo"), { recursive: true });
    const git = fakeGit({ isRepo: true, dirty: true });
    const r = commitHome({ company: "kobo", nowIso: "2026-06-30T12:00:00Z" }, { git: git.run });
    expect(r.ok).toBe(true);
    const seq = git.calls.map((a) => a.join(" "));
    expect(seq).toContain("commit -m home snapshot 2026-06-30T12:00:00Z");
    expect(seq).toContain("push origin main");
  });

  test("--no-push (push:false) commits but does not push", () => {
    require("fs").mkdirSync(homeDir("kobo"), { recursive: true });
    const git = fakeGit({ isRepo: true, dirty: true });
    const r = commitHome({ company: "kobo", push: false, message: "manual" }, { git: git.run });
    expect(r.ok).toBe(true);
    const seq = git.calls.map((a) => a.join(" "));
    expect(seq).toContain("commit -m manual");
    expect(seq.some((s) => s.startsWith("push"))).toBe(false);
  });

  test("push failure → surfaced error", () => {
    require("fs").mkdirSync(homeDir("kobo"), { recursive: true });
    const git = (_c: string, args: string[]): RunResult => {
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return ok("true");
      if (args.join(" ") === "status --porcelain") return ok(" M x");
      if (args[0] === "push") return fail("rejected: remote unreachable");
      return ok();
    };
    const r = commitHome({ company: "kobo" }, { git });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("git push failed");
  });
});
