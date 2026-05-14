/**
 * #1331 — `maw worktree` v1 + `maw done` safety contract.
 *
 * Covers the converged synthesis (impl/test/ship trio) safety contract:
 *
 *   #1  path = <parentDir>/<repoBasename>.wt-<slug>   (NOT agents/<slug>)
 *   #2  --from <ref> → branch created from that ref
 *   #3  default --from → origin/alpha (with origin/main fallback)
 *   #4  remove on clean tree → succeeds (no --force, branch -d)
 *   #5  remove on dirty tree WITHOUT --allow-uncommitted → REFUSES        ★ SAFETY
 *   #6  remove on dirty tree WITH    --allow-uncommitted → --force + -D
 *   #7  done on code-repo worktree (not in fleet config) → NO auto-save  ★ SAFETY
 *   #8  done on oracle  worktree (IS in fleet config)     → auto-save kept (backwards-compat) ★ SAFETY
 *   #9  --split → invokes split path
 *
 * ★ #5, #7, #8 are the load-bearing safety guarantees of #1331 v1: they
 *   prevent contaminating remote feature branches via the legacy commit-+
 *   push auto-save that was designed for oracle vaults.
 *
 * Hermetic: real fs (sandbox tmp dir for MAW_HOME) but NO real git and
 * NO real tmux — `hostExec` and tmux primitives are mocked at module
 * level. Mocks are installed BEFORE any dynamic import of impl files so
 * that the captured FLEET_DIR const in `paths.ts` resolves under the
 * sandbox.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ──────────────────────────────────────────────────────────────────────────
// 1. Sandbox MAW state BEFORE any maw import.
//    paths.ts evaluates `FLEET_DIR = join(CONFIG_DIR, "fleet")` at module
//    load — once frozen, runtime env changes have no effect. Set MAW_HOME
//    here so dynamic-imports below resolve FLEET_DIR under our tmp dir.
// ──────────────────────────────────────────────────────────────────────────

const TEST_HOME = join(tmpdir(), `maw-1331-test-${Date.now()}-${process.pid}`);
process.env.MAW_HOME = TEST_HOME;
// #1308 / shell-bg-verbs precedent: silence verbose "loaded config: …" lines
// fired from src/cli/verbosity.ts via process.stderr.write. Linux Bun 1.3.13
// hits an EEXIST/epoll_ctl bug when WriteStream is lazy-constructed for
// stderr across many module loads; suppressing the writes side-steps it.
process.env.MAW_QUIET = "1";
process.env.MAW_TEST_MODE = "1";
mkdirSync(join(TEST_HOME, "config", "fleet"), { recursive: true });
const FLEET_DIR = join(TEST_HOME, "config", "fleet");

// #1308 — guard against Bun runtime bug: prior test files (or our dynamic
// imports) can corrupt process.stderr.write between bun:test boundaries,
// leaving subsequent .bind() calls to crash with "undefined is not an
// object". Snapshot the pristine reference at module load (before any maw
// import) and restore in afterEach across both describe blocks.
const PRISTINE_STDERR_WRITE = process.stderr.write?.bind?.(process.stderr);
const PRISTINE_STDOUT_WRITE = process.stdout.write?.bind?.(process.stdout);

// Also re-mock paths.ts: snapshot.test.ts (runs before us alphabetically)
// mocks paths.ts to point FLEET_DIR at its OWN tmp dir, and bun's mock.module
// is process-global → without our re-mock, done.ts's isFleetRegisteredWindow
// would read from snapshot's tmp dir (not ours) and never find the fleet
// config files we write below.
mock.module("../../src/core/paths", () => ({
  MAW_ROOT: "/tmp",
  CONFIG_DIR: join(TEST_HOME, "config"),
  FLEET_DIR,
  CONFIG_FILE: join(TEST_HOME, "config", "maw.config.json"),
  resolveHome: () => TEST_HOME,
  getConfigDir: () => join(TEST_HOME, "config"),
  getFleetDir: () => FLEET_DIR,
  getConfigFile: () => join(TEST_HOME, "config", "maw.config.json"),
}));

// ──────────────────────────────────────────────────────────────────────────
// 2. SSH (hostExec) + tmux mocks.
//    Each handler is matched on first include / regex hit. Tests register
//    handlers via `onHostExec(...)` inside the test body.
// ──────────────────────────────────────────────────────────────────────────

interface HostExecHandler {
  match: (cmd: string) => boolean;
  respond: (cmd: string) => string | Promise<string>;
}
let hostExecHandlers: HostExecHandler[] = [];
let hostExecCalls: string[] = [];
let listSessionsReturn: Array<{
  name: string;
  windows: Array<{ index: number; name: string; active: boolean }>;
}> = [];

import { mockSshModule } from "../helpers/mock-ssh";
mock.module("../../src/core/transport/ssh", () =>
  mockSshModule({
    hostExec: async (cmd: string) => {
      hostExecCalls.push(cmd);
      for (const h of hostExecHandlers) {
        if (h.match(cmd)) return await h.respond(cmd);
      }
      return "";
    },
    listSessions: async () => listSessionsReturn,
    // Provide an isAgentCommand that matches the real impl shape: classic
    // binaries AND Claude Code 2.1+ versioned signatures. mock-ssh.ts's
    // default omits the version check, which leaks into is-agent-command
    // tests after bun's process-global mock.module replaces the real one.
    isAgentCommand: (cmd: string | null | undefined): boolean => {
      const c = (cmd ?? "").trim();
      if (!c) return false;
      if (/claude|codex|node/i.test(c)) return true;
      if (/^\d+\.\d+\.\d+$/.test(c)) return true;
      return false;
    },
  }),
);

let tmuxCalls: string[] = [];
let tmuxHasSession = false;
let tmuxWindows: Array<{ index: number; name: string; active: boolean }> = [];
mock.module("../../src/core/transport/tmux", () => ({
  tmux: {
    hasSession: async (name: string) => {
      tmuxCalls.push(`hasSession ${name}`);
      return tmuxHasSession;
    },
    newSession: async (name: string, opts: any) => {
      tmuxCalls.push(`newSession ${name} window=${opts?.window ?? ""}`);
    },
    newWindow: async (session: string, name: string, _opts?: any) => {
      tmuxCalls.push(`newWindow ${session}:${name}`);
    },
    listWindows: async (_session: string) => tmuxWindows,
    killWindow: async (target: string) => {
      tmuxCalls.push(`killWindow ${target}`);
    },
    sendText: async (target: string, _text: string) => {
      tmuxCalls.push(`sendText ${target}`);
    },
  },
  Tmux: class {},
  resolveSocket: () => undefined,
  tmuxCmd: () => "tmux",
  withPaneLock: async (_target: string, fn: any) => await fn(),
  splitWindowLocked: async () => {},
  tagPane: async () => {},
  readPaneTags: async () => ({}),
}));

// ──────────────────────────────────────────────────────────────────────────
// 3. Helpers
// ──────────────────────────────────────────────────────────────────────────

function onHostExec(
  match: string | RegExp,
  respond: string | ((cmd: string) => string | Promise<string>),
): void {
  hostExecHandlers.push({
    match: (cmd) => (typeof match === "string" ? cmd.includes(match) : match.test(cmd)),
    respond: typeof respond === "function" ? respond : () => respond,
  });
}

function resetState(): void {
  hostExecHandlers = [];
  hostExecCalls = [];
  tmuxCalls = [];
  tmuxHasSession = false;
  tmuxWindows = [];
  listSessionsReturn = [];
}

/**
 * #1308 defensive — re-install the pristine stderr/stdout writers if some
 * prior test (or Bun's lazy WriteStream init) left them as undefined or
 * monkey-patched. Costs ~0ms; prevents the EEXIST/epoll_ctl cascade where
 * a later test's `.bind(process.stderr)` throws "undefined is not an
 * object" because the captured reference was disposed mid-shard.
 */
function restorePristineStreams(): void {
  if (PRISTINE_STDERR_WRITE && typeof process.stderr.write !== "function") {
    (process.stderr as any).write = PRISTINE_STDERR_WRITE;
  }
  if (PRISTINE_STDOUT_WRITE && typeof process.stdout.write !== "function") {
    (process.stdout as any).write = PRISTINE_STDOUT_WRITE;
  }
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const origErr = console.error;
  console.error = (...args: any[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, restore: () => { console.error = origErr; } };
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Tests
// ──────────────────────────────────────────────────────────────────────────

describe("#1331 — maw worktree v1", () => {
  beforeEach(() => {
    restorePristineStreams();
    resetState();
    // Wipe fleet dir per-test so configs from prior tests don't bleed in.
    try { rmSync(FLEET_DIR, { recursive: true, force: true }); } catch { /* expected */ }
    mkdirSync(FLEET_DIR, { recursive: true });
  });

  afterEach(() => {
    resetState();
    restorePristineStreams();
  });

  // ────────────────────────────────────────────────────────────────────────
  // worktree add — path scheme + branch resolution
  // ────────────────────────────────────────────────────────────────────────

  describe("worktree add", () => {
    test("#1 path scheme = <parentDir>/<repoBasename>.wt-<slug> (NOT agents/<slug>)", async () => {
      const repoDir = join(TEST_HOME, "fakerepo");
      mkdirSync(repoDir, { recursive: true });
      // git rev-parse --git-dir succeeds; default ref probe succeeds; worktree add succeeds.
      onHostExec("rev-parse --git-dir", "");
      onHostExec("worktree add", "");

      const { cmdWorktreeAdd } = await import("../../src/commands/shared/worktree-cmd");
      const target = await cmdWorktreeAdd(repoDir, "feature-x", { noAttach: true });

      // Path captured in `git worktree add '<wtPath>' -b 'feat/<slug>' '<from>'`
      const wtAddCmd = hostExecCalls.find(c => c.includes("worktree add '"));
      expect(wtAddCmd).toBeDefined();
      expect(wtAddCmd).toContain(`'${TEST_HOME}/fakerepo.wt-feature-x'`);
      // Explicitly NOT the rejected agents/<slug> layout
      expect(wtAddCmd).not.toContain("/agents/feature-x");
      // Branch name = feat/<slug>
      expect(wtAddCmd).toContain("-b 'feat/feature-x'");
      // Returns tmux target session:window (per-repo session named after repo basename)
      expect(target).toBe("fakerepo:feature-x");
    });

    test("#2 --from <ref> → branch created from that ref", async () => {
      const repoDir = join(TEST_HOME, "repo2");
      mkdirSync(repoDir, { recursive: true });
      onHostExec("rev-parse --git-dir", "");
      onHostExec("worktree add", "");

      const { cmdWorktreeAdd } = await import("../../src/commands/shared/worktree-cmd");
      await cmdWorktreeAdd(repoDir, "feat-y", { from: "origin/main", noAttach: true });

      const wtAddCmd = hostExecCalls.find(c => c.includes("worktree add '"));
      expect(wtAddCmd).toBeDefined();
      expect(wtAddCmd).toContain("-b 'feat/feat-y'");
      expect(wtAddCmd).toContain("'origin/main'");
      // Did NOT fall through to the alpha default
      expect(wtAddCmd).not.toContain("'origin/alpha'");
    });

    test("#3 default --from → origin/alpha when present", async () => {
      const repoDir = join(TEST_HOME, "repo3a");
      mkdirSync(repoDir, { recursive: true });
      onHostExec("rev-parse --git-dir", "");
      // Default hostExec (no throw) → refExists returns true for origin/alpha
      onHostExec("worktree add", "");

      const { cmdWorktreeAdd } = await import("../../src/commands/shared/worktree-cmd");
      await cmdWorktreeAdd(repoDir, "slug-a", { noAttach: true });

      const wtAddCmd = hostExecCalls.find(c => c.includes("worktree add '"));
      expect(wtAddCmd).toContain("'origin/alpha'");
    });

    test("#3 default --from → falls back to origin/main when origin/alpha absent", async () => {
      const repoDir = join(TEST_HOME, "repo3b");
      mkdirSync(repoDir, { recursive: true });
      onHostExec("rev-parse --git-dir", "");
      // origin/alpha probe throws → refExists false → try origin/main next
      onHostExec(/rev-parse --verify 'origin\/alpha'/, () => {
        throw new Error("ref not found: origin/alpha");
      });
      onHostExec(/rev-parse --verify 'origin\/main'/, "main-sha");
      onHostExec("worktree add", "");

      const { cmdWorktreeAdd } = await import("../../src/commands/shared/worktree-cmd");
      await cmdWorktreeAdd(repoDir, "slug-b", { noAttach: true });

      const wtAddCmd = hostExecCalls.find(c => c.includes("worktree add '"));
      expect(wtAddCmd).toContain("'origin/main'");
      expect(wtAddCmd).not.toContain("'origin/alpha'");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // worktree remove — safety contract (#5 is the SAFETY assertion)
  // ────────────────────────────────────────────────────────────────────────

  describe("worktree remove", () => {
    test("#4 clean tree → succeeds (no --force, safe branch delete)", async () => {
      onHostExec("-name '*.wt-clean'", `${TEST_HOME}/myrepo.wt-clean\n`);
      onHostExec("status --porcelain", ""); // clean
      onHostExec("rev-parse --abbrev-ref HEAD", "feat/clean");
      onHostExec("worktree remove", "");
      onHostExec("worktree prune", "");
      onHostExec("branch -d", "");

      const { cmdWorktreeRemove } = await import("../../src/commands/shared/worktree-cmd");
      await cmdWorktreeRemove("clean", {});

      const removeCmd = hostExecCalls.find(c => c.includes("worktree remove '"));
      expect(removeCmd).toBeDefined();
      // Clean path uses SAFE remove — no --force
      expect(removeCmd).not.toContain("--force");
      // Safe branch delete (-d, not -D)
      const branchCmd = hostExecCalls.find(c => /\bbranch -[dD] /.test(c));
      expect(branchCmd).toBeDefined();
      expect(branchCmd).toContain("branch -d ");
      expect(branchCmd).not.toContain("branch -D ");
      // Tmux window kill issued
      expect(tmuxCalls.some(c => c.startsWith("killWindow"))).toBe(true);
    });

    test("#5 ★SAFETY — dirty tree WITHOUT --allow-uncommitted → REFUSES with clear error", async () => {
      onHostExec("-name '*.wt-dirty'", `${TEST_HOME}/myrepo.wt-dirty\n`);
      onHostExec("status --porcelain", " M src/foo.ts\n?? src/bar.ts\n");

      const { cmdWorktreeRemove } = await import("../../src/commands/shared/worktree-cmd");

      const stderr = captureStderr();
      let thrown: Error | null = null;
      try {
        await cmdWorktreeRemove("dirty", {}); // critical: NO --allow-uncommitted
      } catch (e) {
        thrown = e as Error;
      } finally {
        stderr.restore();
      }

      // (a) MUST throw — exit-1 contract via UserError
      expect(thrown).not.toBeNull();
      expect(thrown?.constructor?.name).toBe("UserError");

      // (b) Clear error message mentioning the bypass flag (remediation guidance)
      const allErr = stderr.lines.join("\n");
      expect(allErr.toLowerCase()).toContain("uncommitted");
      expect(allErr).toContain("--allow-uncommitted");

      // (c) Worktree NOT removed — no `git worktree remove` issued
      expect(hostExecCalls.some(c => c.includes("worktree remove '"))).toBe(false);
      // (d) tmux window NOT killed (we refused before any side effects)
      expect(tmuxCalls.some(c => c.startsWith("killWindow"))).toBe(false);
      // (e) Branch NOT deleted
      expect(hostExecCalls.some(c => /\bbranch -[dD] /.test(c))).toBe(false);
    });

    test("#6 dirty tree WITH --allow-uncommitted → succeeds with --force + -D", async () => {
      onHostExec("-name '*.wt-dirtyok'", `${TEST_HOME}/myrepo.wt-dirtyok\n`);
      onHostExec("status --porcelain", " M src/foo.ts\n"); // dirty (ignored)
      onHostExec("rev-parse --abbrev-ref HEAD", "feat/dirtyok");
      onHostExec("worktree remove", "");
      onHostExec("worktree prune", "");
      onHostExec("branch -D", "");

      const { cmdWorktreeRemove } = await import("../../src/commands/shared/worktree-cmd");
      await cmdWorktreeRemove("dirtyok", { allowUncommitted: true });

      // git worktree remove invoked WITH --force
      const removeCmd = hostExecCalls.find(c => c.includes("worktree remove '"));
      expect(removeCmd).toBeDefined();
      expect(removeCmd).toContain("--force");
      // Branch delete uses -D (force) — matches the --allow-uncommitted intent
      const branchCmd = hostExecCalls.find(c => /\bbranch -[dD] /.test(c));
      expect(branchCmd).toBeDefined();
      expect(branchCmd).toContain("branch -D ");
    });

    test("ambiguous slug (multiple matches) → throws", async () => {
      // Defensive guard from impl: surfacing ambiguous slugs prevents silently
      // deleting the wrong worktree when slugs collide across repos.
      onHostExec(
        "-name '*.wt-ambig'",
        `${TEST_HOME}/repo-a.wt-ambig\n${TEST_HOME}/repo-b.wt-ambig\n`,
      );

      const { cmdWorktreeRemove } = await import("../../src/commands/shared/worktree-cmd");
      const stderr = captureStderr();
      let thrown: Error | null = null;
      try {
        await cmdWorktreeRemove("ambig", {});
      } catch (e) {
        thrown = e as Error;
      } finally {
        stderr.restore();
      }
      expect(thrown).not.toBeNull();
      expect(thrown?.constructor?.name).toBe("UserError");
      // Impl surfaces ambiguity via a "matches N worktrees" + "disambiguate"
      // stderr; assert on that wording (UserError throw msg is internal).
      const errLower = stderr.lines.join("\n").toLowerCase();
      expect(errLower).toContain("matches 2 worktrees");
      expect(errLower).toContain("disambiguate");
      // No destructive ops fired
      expect(hostExecCalls.some(c => c.includes("worktree remove '"))).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // --split flag (#9)
  // ────────────────────────────────────────────────────────────────────────

  describe("--split flag", () => {
    test("#9 --split=true → invokes split path (reaches maybeSplit / probes tmux)", async () => {
      const repoDir = join(TEST_HOME, "splitrepo");
      mkdirSync(repoDir, { recursive: true });
      onHostExec("rev-parse --git-dir", "");
      onHostExec("worktree add", "");
      // probeTmuxServer's "tmux display-message -p '#S'" call should be made
      // when --split is set and we're not inside a tmux pane.
      onHostExec("tmux display-message", () => {
        throw new Error("no tmux server");
      });

      const wasTmux = process.env.TMUX;
      delete process.env.TMUX;
      try {
        const { cmdWorktreeAdd } = await import("../../src/commands/shared/worktree-cmd");
        await cmdWorktreeAdd(repoDir, "splitslug", { split: true, noAttach: true });
      } finally {
        if (wasTmux !== undefined) process.env.TMUX = wasTmux;
      }

      // The --split path's probe was reached.
      expect(hostExecCalls.some(c => c.includes("tmux display-message"))).toBe(true);
    });

    test("--split=false → split path NOT invoked", async () => {
      const repoDir = join(TEST_HOME, "nosplitrepo");
      mkdirSync(repoDir, { recursive: true });
      onHostExec("rev-parse --git-dir", "");
      onHostExec("worktree add", "");

      const { cmdWorktreeAdd } = await import("../../src/commands/shared/worktree-cmd");
      await cmdWorktreeAdd(repoDir, "nosplitslug", { noAttach: true });

      // maybeSplit returns immediately when opts.split is falsy.
      expect(hostExecCalls.some(c => c.includes("tmux display-message"))).toBe(false);
    });
  });
});

describe("#1331 — maw done — auto-save discriminator (★ #7, #8, plus dirty-refuse)", () => {
  beforeEach(() => {
    resetState();
    try { rmSync(FLEET_DIR, { recursive: true, force: true }); } catch { /* expected */ }
    mkdirSync(FLEET_DIR, { recursive: true });
  });

  afterEach(() => {
    resetState();
  });

  test("#7 ★SAFETY — code-repo worktree (window NOT in fleet config) → NO auto-save (no commit, no push, no /rrr)", async () => {
    // Fleet config registers ONLY oracle windows — none match our target.
    writeFileSync(
      join(FLEET_DIR, "white.json"),
      JSON.stringify({
        windows: [
          { name: "neo-oracle", repo: "Soul-Brews-Studio/neo" },
          { name: "pulse-oracle", repo: "Soul-Brews-Studio/pulse" },
        ],
      }),
    );

    // tmux sees the code-repo window in a per-repo session.
    listSessionsReturn = [
      { name: "maw-js", windows: [{ index: 1, name: "feature-x", active: true }] },
    ];

    // display-message returns the pane cwd; status returns clean so we don't
    // trip the dirty-tree refusal — we only want to assert auto-save is skipped.
    onHostExec("display-message", `${TEST_HOME}/codewt`);
    onHostExec("status --porcelain", "");

    const { cmdDone } = await import("../../src/commands/shared/done");
    await cmdDone("feature-x", { force: false });

    // ★ Critical assertion #1: no git add / commit / push fired.
    expect(hostExecCalls.some(c => c.includes("add -A"))).toBe(false);
    expect(hostExecCalls.some(c => c.includes("commit -m"))).toBe(false);
    expect(hostExecCalls.some(c => /\bpush\b/.test(c))).toBe(false);

    // ★ Critical assertion #2: no /rrr send-text to the pane (that's the
    //   auto-save preamble — must not fire for code-repo worktrees).
    expect(tmuxCalls.some(c => c.startsWith("sendText"))).toBe(false);

    // Sanity: cleanup path still ran (window kill + worktree removal best-effort)
    expect(tmuxCalls.some(c => c.startsWith("killWindow"))).toBe(true);
  });

  // NB: 15s timeout — autoSave waits 10s after sending /rrr (`await new
  // Promise(r => setTimeout(r, 10_000))` in done.ts). That sleep is part of
  // the auto-save contract we're verifying — don't mock it away.
  test("#8 ★SAFETY — oracle worktree (window IS in fleet config) → auto-save preserved (backwards-compat)", async () => {
    // Fleet config DOES contain the target window — classic oracle vault path.
    writeFileSync(
      join(FLEET_DIR, "white.json"),
      JSON.stringify({
        windows: [
          { name: "neo-oracle", repo: "Soul-Brews-Studio/neo.wt-some-task" },
        ],
      }),
    );

    listSessionsReturn = [
      { name: "03-neo", windows: [{ index: 1, name: "neo-oracle", active: true }] },
    ];

    onHostExec("display-message", `${TEST_HOME}/oraclewt`);
    // Make worktree-remove and branch-delete hostExec calls succeed.
    onHostExec("worktree remove", "");
    onHostExec("worktree prune", "");
    onHostExec("branch -d", "");
    onHostExec("rev-parse --abbrev-ref HEAD", "feat/oracle-task");

    const { cmdDone } = await import("../../src/commands/shared/done");
    await cmdDone("neo-oracle", { force: false });

    // ★ Critical assertion: auto-save body fired (git add + commit + push)
    expect(hostExecCalls.some(c => c.includes("add -A"))).toBe(true);
    expect(hostExecCalls.some(c => c.includes("commit -m"))).toBe(true);
    expect(hostExecCalls.some(c => /\bpush\b/.test(c))).toBe(true);

    // ★ /rrr preamble was sent to the oracle pane
    expect(tmuxCalls.some(c => c.startsWith("sendText"))).toBe(true);
  }, 15000);

  test("done on code-repo with dirty tree (no --allow-uncommitted) → refuses, no kill, no auto-save", async () => {
    writeFileSync(
      join(FLEET_DIR, "white.json"),
      JSON.stringify({ windows: [{ name: "neo-oracle" }] }), // unrelated window
    );

    listSessionsReturn = [
      { name: "maw-js", windows: [{ index: 1, name: "feature-dirty", active: true }] },
    ];

    onHostExec("display-message", `${TEST_HOME}/dirtycwd`);
    onHostExec("status --porcelain", " M src/foo.ts\n");

    const { cmdDone } = await import("../../src/commands/shared/done");
    const stderr = captureStderr();
    let thrown: Error | null = null;
    try {
      await cmdDone("feature-dirty", {});
    } catch (e) {
      thrown = e as Error;
    } finally {
      stderr.restore();
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.constructor?.name).toBe("UserError");
    expect(stderr.lines.join("\n")).toContain("--allow-uncommitted");

    // Refusal happens BEFORE side effects — no kill, no auto-save
    expect(tmuxCalls.some(c => c.startsWith("killWindow"))).toBe(false);
    expect(hostExecCalls.some(c => c.includes("commit -m"))).toBe(false);
    expect(tmuxCalls.some(c => c.startsWith("sendText"))).toBe(false);
  });

  test("done on code-repo with dirty tree + --allow-uncommitted → proceeds, still skips auto-save", async () => {
    // --allow-uncommitted is the bypass for code-repo dirty refusal, NOT a
    // request to re-enable auto-save. The discriminator decides auto-save;
    // the flag only controls the dirty-tree gate.
    writeFileSync(
      join(FLEET_DIR, "white.json"),
      JSON.stringify({ windows: [{ name: "neo-oracle" }] }),
    );

    listSessionsReturn = [
      { name: "maw-js", windows: [{ index: 1, name: "feature-dirty-ok", active: true }] },
    ];

    onHostExec("display-message", `${TEST_HOME}/dirtyokcwd`);
    onHostExec("status --porcelain", " M src/foo.ts\n");

    const { cmdDone } = await import("../../src/commands/shared/done");
    await cmdDone("feature-dirty-ok", { allowUncommitted: true });

    // No auto-save (discriminator still says code-repo)
    expect(hostExecCalls.some(c => c.includes("add -A"))).toBe(false);
    expect(hostExecCalls.some(c => c.includes("commit -m"))).toBe(false);
    expect(hostExecCalls.some(c => /\bpush\b/.test(c))).toBe(false);
    expect(tmuxCalls.some(c => c.startsWith("sendText"))).toBe(false);

    // But cleanup (kill) DID run since we bypassed the refusal
    expect(tmuxCalls.some(c => c.startsWith("killWindow"))).toBe(true);
  });
});
