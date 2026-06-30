/**
 * Company Home as a git repo (ADR 0002) — sync / audit / backup.
 *
 * The home (`~/.maw/companies/<c>/`, mawDataPath) already holds the company's
 * policy/, state.md and tasks/*.json. This turns that dir into a per-company
 * PRIVATE git repo so it can sync across machines, roll back, and back up.
 *
 * Design locks (ADR 0002):
 *   - single-writer (1 company = 1 machine) → NO conflict/merge handling here.
 *   - git NEVER runs in the engine hot-path — commit is an explicit verb only
 *     (`maw home commit`, called by cron / clock-out), never per `maw task` op.
 *   - per-company repo (NOT monorepo — a shared remote reintroduces push-race
 *     multi-writer) and PRIVATE (home carries internal policy/state — no leak).
 *   - worklog.jsonl is gitignored: high-churn (every tool call) + ~MBs of noise;
 *     it's a runtime audit log, not version-controlled. tasks/*.json ARE tracked
 *     so git history becomes the work-record once the worklog is excluded.
 *
 * Orchestration takes injectable git/gh runners so unit tests exercise the
 * command sequence without a real repo or network.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mawDataPath } from "../xdg";
import { runGit, runGh, type GhRunner, type GitRunner } from "./git";

/** company → safe single path segment (no traversal / separators / dots). */
export function safeSegment(company: string): string {
  return company.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Absolute path to the company home (the git repo root). */
export function homeDir(company: string): string {
  return mawDataPath("companies", safeSegment(company));
}

/** Default private remote slug for a company home, in `org` (ADR: meganechan). */
export function defaultRepoSlug(company: string, org = "meganechan"): string {
  return `${org}/maw-home-${safeSegment(company)}`;
}

/** .gitignore body for a home repo — worklog excluded, everything else tracked. */
export const GITIGNORE_LINES: string[] = [
  "# maw Company Home (ADR 0002) — runtime audit log is high-churn + noisy,",
  "# not version-controlled. tasks/, policy/, state.md ARE tracked.",
  "worklog.jsonl",
  "*.tmp",
];

export interface HomeDeps {
  git?: GitRunner;
  gh?: GhRunner;
}

export interface HomeResult {
  ok: boolean;
  dir: string;
  steps: string[]; // human-readable progress lines (also the test seam)
  error?: string;
}

/** True when `dir` is already a git work tree. */
export function isGitRepo(dir: string, git: GitRunner = runGit): boolean {
  return git(dir, ["rev-parse", "--is-inside-work-tree"]).stdout === "true";
}

/**
 * Ensure `<dir>/.gitignore` excludes worklog.jsonl. Appends the home block when
 * the file is absent or doesn't already ignore the worklog. Returns true if it
 * wrote. Idempotent — re-running never duplicates the entry.
 */
export function ensureGitignore(dir: string): boolean {
  const path = join(dir, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const alreadyIgnored = existing.split(/\r?\n/).some((l) => l.trim() === "worklog.jsonl");
  if (alreadyIgnored) return false;
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(path, existing + sep + GITIGNORE_LINES.join("\n") + "\n");
  return true;
}

export interface InitHomeInput {
  company: string;
  org?: string; // default meganechan
  repo?: string; // full slug override (org/name); else defaultRepoSlug
  branch?: string; // default main
}

/**
 * `maw home init` — turn the company home into a private git repo with a remote.
 * Idempotent: re-running skips git-init / repo-create / remote-add that already
 * exist and just commits + pushes any new state.
 *
 * Sequence: ensure dir + .gitignore → git init -b <branch> → stage + initial
 * commit → create the PRIVATE GitHub repo from the local source and push.
 */
export function initHome(input: InitHomeInput, deps: HomeDeps = {}): HomeResult {
  const git = deps.git ?? runGit;
  const gh = deps.gh ?? runGh;
  const branch = input.branch ?? "main";
  const slug = input.repo ?? defaultRepoSlug(input.company, input.org);
  const dir = homeDir(input.company);
  const steps: string[] = [];

  mkdirSync(dir, { recursive: true });

  if (ensureGitignore(dir)) steps.push(".gitignore → worklog.jsonl excluded");
  else steps.push(".gitignore already excludes worklog.jsonl");

  if (!isGitRepo(dir, git)) {
    const r = git(dir, ["init", "-b", branch]);
    if (!r.ok) return { ok: false, dir, steps, error: `git init failed: ${r.stderr || r.stdout}` };
    steps.push(`git init (branch ${branch})`);
  } else {
    steps.push("already a git repo");
  }

  git(dir, ["add", "-A"]);
  const status = git(dir, ["status", "--porcelain"]).stdout;
  if (status) {
    const c = git(dir, ["commit", "-m", "init: company home (ADR 0002)"]);
    if (!c.ok) return { ok: false, dir, steps, error: `git commit failed: ${c.stderr || c.stdout}` };
    steps.push("committed current home state");
  } else {
    steps.push("nothing to commit (clean)");
  }

  // Remote: if one already exists, just push; else create the PRIVATE repo from
  // this local source and push in one shot.
  const hasOrigin = git(dir, ["remote", "get-url", "origin"]).ok;
  if (hasOrigin) {
    const p = git(dir, ["push", "-u", "origin", branch]);
    if (!p.ok) return { ok: false, dir, steps, error: `git push failed: ${p.stderr || p.stdout}` };
    steps.push(`pushed → existing origin (${branch})`);
  } else {
    const create = gh(["repo", "create", slug, "--private", "--source", dir, "--remote", "origin", "--push"], dir);
    if (!create.ok) {
      const msg = create.stderr || create.stdout;
      if (/already exists|Name already exists/i.test(msg)) {
        // Repo exists on GitHub but no local remote — wire it up + push.
        git(dir, ["remote", "add", "origin", `https://github.com/${slug}.git`]);
        const p = git(dir, ["push", "-u", "origin", branch]);
        if (!p.ok) return { ok: false, dir, steps, error: `git push failed: ${p.stderr || p.stdout}` };
        steps.push(`linked existing private repo ${slug} + pushed`);
      } else if (/403|admin|permission/i.test(msg)) {
        return { ok: false, dir, steps, error: `no permission to create repos in ${slug.split("/")[0]} — ask an org admin to create ${slug} (private), then re-run` };
      } else {
        return { ok: false, dir, steps, error: `gh repo create failed: ${msg}` };
      }
    } else {
      steps.push(`created PRIVATE repo ${slug} + pushed`);
    }
  }

  return { ok: true, dir, steps };
}

export interface CommitHomeInput {
  company: string;
  message?: string;
  branch?: string; // default main
  push?: boolean; // default true
  nowIso?: string; // injectable timestamp (default new Date)
}

/**
 * `maw home commit` — snapshot the whole home (stage + commit + push). Called by
 * cron / clock-out, NOT the engine. worklog.jsonl stays excluded by .gitignore.
 * "nothing to commit" is a benign success, not an error.
 */
export function commitHome(input: CommitHomeInput, deps: HomeDeps = {}): HomeResult {
  const git = deps.git ?? runGit;
  const branch = input.branch ?? "main";
  const dir = homeDir(input.company);
  const steps: string[] = [];

  if (!existsSync(dir) || !isGitRepo(dir, git)) {
    return { ok: false, dir, steps, error: `home not initialized — run 'maw home init ${input.company}' first` };
  }

  // Defensive: a home created before init should still never commit the worklog.
  ensureGitignore(dir);

  git(dir, ["add", "-A"]);
  const status = git(dir, ["status", "--porcelain"]).stdout;
  if (!status) {
    steps.push("nothing to commit (home clean)");
    return { ok: true, dir, steps };
  }

  const iso = input.nowIso ?? new Date().toISOString();
  const message = input.message ?? `home snapshot ${iso}`;
  const c = git(dir, ["commit", "-m", message]);
  if (!c.ok) return { ok: false, dir, steps, error: `git commit failed: ${c.stderr || c.stdout}` };
  steps.push(`committed: ${message}`);

  if (input.push ?? true) {
    const p = git(dir, ["push", "origin", branch]);
    if (!p.ok) return { ok: false, dir, steps, error: `git push failed: ${p.stderr || p.stdout}` };
    steps.push(`pushed → origin (${branch})`);
  }

  return { ok: true, dir, steps };
}
