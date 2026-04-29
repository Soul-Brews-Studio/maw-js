/**
 * #957 — `maw ls` (cmdList) must be strictly read-only on tmux state.
 *
 * Issue: users reported that every `maw ls` invocation left orphan tmux
 * grouped sessions named `<session>-view` and `<session>-view-diag`. The
 * orphans accumulate across runs and pollute window-name resolution.
 *
 * Root-cause audit (this branch): the source-tree cmdList calls only
 * read-only tmux helpers — `listSessions` (`tmux list-sessions`,
 * `list-windows`), `getPaneInfos` (`tmux list-panes`), and `scanWorktrees`
 * (`find` + `git worktree list`). None of these create sessions. The
 * external orphans observed in the wild came from extracted plugins or
 * user hooks, not cmdList itself.
 *
 * This test pins the contract using a real tmux server on an isolated
 * socket. `maw ls` is invoked in a freshly-spawned subprocess (via
 * `bun src/cli.ts ls`) so module-mock pollution from sibling test files
 * cannot leak in. We seed two sessions, run `maw ls` three times, and
 * assert no `*-view` / `*-view-diag` sessions appeared. If a future
 * change re-introduces a `tmux new-session -t ...` inside cmdList's
 * call chain, this test will fail.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SOCKET_NAME = "maw-957-test";
let socketDir: string;
let socketPath: string;

function tmux(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync("tmux", ["-S", socketPath, ...args], {
    encoding: "utf-8",
    env: { ...process.env, TMUX: "" },
  });
  return {
    stdout: res.stdout?.trim() ?? "",
    stderr: res.stderr?.trim() ?? "",
    status: res.status,
  };
}

function listSessions(): string[] {
  const r = tmux("list-sessions", "-F", "#{session_name}");
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter(Boolean).sort();
}

function runMawLs(): { status: number | null; stderr: string } {
  // Spawn a fresh subprocess. This bypasses the mock.module pollution that
  // plagues test/isolated/ (see test/helpers/mock-ssh.ts comments) — the
  // subprocess imports src/cli.ts and src/commands/shared/comm-list.ts
  // from the real on-disk modules, so we exercise the actual transport
  // chain with no test-suite stubs in the way.
  const cliPath = resolve(import.meta.dir, "../../src/cli.ts");
  const res = spawnSync("bun", [cliPath, "ls"], {
    encoding: "utf-8",
    env: {
      ...process.env,
      MAW_TMUX_SOCKET: socketPath,
      MAW_HOST: "local",
      // Quiet the bootstrap noise — we only care about side effects.
      MAW_QUIET: "1",
    },
    timeout: 30000,
  });
  return { status: res.status, stderr: res.stderr ?? "" };
}

beforeAll(() => {
  socketDir = mkdtempSync(join(tmpdir(), "maw-957-"));
  socketPath = join(socketDir, SOCKET_NAME);
  // Seed two sessions that mirror the bug report's repro shape.
  tmux("new-session", "-d", "-s", "leica", "-n", "main");
  tmux("new-session", "-d", "-s", "03-pops-clinic", "-n", "main");
});

afterAll(() => {
  tmux("kill-server");
  try { rmSync(socketDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("#957 — maw ls is strictly read-only on tmux state", () => {
  test("`maw ls` does not create any new tmux sessions", () => {
    const before = listSessions();
    expect(before).toEqual(["03-pops-clinic", "leica"]);

    const r = runMawLs();
    expect(r.status).toBe(0);

    const after = listSessions();
    expect(after).toEqual(before);
  });

  test("repeated `maw ls` invocations leave no '*-view' / '*-view-diag' orphans", () => {
    runMawLs();
    runMawLs();
    runMawLs();

    const after = listSessions();
    const orphans = after.filter(s => /-view$/.test(s) || /-view-diag$/.test(s));
    expect(orphans).toEqual([]);
    // Sanity: original fleet still intact.
    expect(after.includes("leica")).toBe(true);
    expect(after.includes("03-pops-clinic")).toBe(true);
  });
});
