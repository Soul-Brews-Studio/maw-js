import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type SpawnSyncResult = ReturnType<typeof Bun.spawnSync>;

function run(cmd: string[], options: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number; allowFailure?: boolean } = {}): SpawnSyncResult {
  const result = Bun.spawnSync({
    cmd,
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeout ?? 10_000,
  });
  if (!options.allowFailure && !result.success) {
    throw new Error(`${cmd.join(" ")} failed (${result.exitCode})\nSTDOUT:\n${result.stdout.toString()}\nSTDERR:\n${result.stderr.toString()}`);
  }
  return result;
}

function commandAvailable(cmd: string[]): boolean {
  return run(cmd, { allowFailure: true, timeout: 2_000 }).success;
}

function writeSmokeConfig(home: string): void {
  const configDir = join(home, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "maw.config.json"), JSON.stringify({
    node: "local",
    host: "local",
    commands: { default: "claude", codex: "codex" },
    defaultEngine: "codex",
    engines: { codex: { cmd: "codex", label: "Codex CLI" } },
    agents: {},
    namedPeers: [],
  }, null, 2) + "\n");
}

function smokeEnv(home: string): Record<string, string | undefined> {
  writeSmokeConfig(home);
  return {
    ...process.env,
    MAW_HOME: home,
    MAW_STATE_DIR: join(home, "state"),
    MAW_CONFIG_DIR: join(home, "config"),
    MAW_DISABLE_UPDATE_CHECK: "1",
  };
}

function createShellSession(session: string, sentinel: string): { paneId: string; target: string } {
  run(["tmux", "kill-session", "-t", session], { allowFailure: true, timeout: 2_000 });
  run([
    "tmux", "new-session", "-d", "-x", "106", "-y", "30", "-s", session,
    "--", "bash", "-lc", `printf 'ready ${sentinel}\\n'; exec bash --noprofile --norc`,
  ], { timeout: 5_000 });

  const paneLine = run([
    "tmux", "list-panes", "-t", session,
    "-F", "#{pane_id}|#{session_name}:#{window_index}.#{pane_index}",
  ], { timeout: 5_000 }).stdout.toString().trim().split("\n")[0] ?? "";
  const [paneId = "", target = ""] = paneLine.split("|");
  if (!paneId.startsWith("%") || !target.includes(":")) {
    throw new Error(`failed to resolve smoke pane target for ${session}: ${paneLine || "empty"}`);
  }
  return { paneId, target };
}

function capture(target: string): string {
  return run(["tmux", "capture-pane", "-t", target, "-p", "-S", "-80"], { timeout: 5_000 }).stdout.toString();
}

async function waitForCapture(target: string, needle: string, timeoutMs = 5_000): Promise<string> {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    last = capture(target);
    if (last.includes(needle)) return last;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${needle} in ${target}; last capture:\n${last}`);
}

function cli(repo: string, env: Record<string, string | undefined>, args: string[], timeout = 10_000): string {
  return run(["bun", "src/cli.ts", ...args], { cwd: repo, env, timeout }).stdout.toString();
}

describe("daily ops real-entry contract smokes", () => {
  test("maw send, send-enter, and run cross the real CLI/Tmux boundary", async () => {
    if (!commandAvailable(["tmux", "-V"])) {
      console.warn("SKIP daily ops real-entry smoke: tmux binary is unavailable");
      return;
    }

    const repo = join(import.meta.dir, "..");
    const session = `maw-daily-ops-2751-${process.pid}`;
    const home = mkdtempSync(join(tmpdir(), "maw-daily-ops-2751-"));
    const env = smokeEnv(home);
    const ready = `MAW2751-ready-${process.pid}`;
    const sendSentinel = `MAW2751-send-${process.pid}`;
    const runSentinel = `MAW2751-run-${process.pid}`;
    let paneId = "";

    try {
      const created = createShellSession(session, ready);
      paneId = created.paneId;
      const target = created.target;
      await waitForCapture(paneId, ready);

      const sendOutput = cli(repo, env, ["send", target, `${sendSentinel} from real top-level send`, "--no-verify-submit"]);
      expect(sendOutput).toContain("delivered");
      await waitForCapture(paneId, sendSentinel);

      run(["tmux", "send-keys", "-t", paneId, "-l", `printf '${sendSentinel}-enter\\n'`], { timeout: 5_000 });
      await waitForCapture(paneId, `printf '${sendSentinel}-enter\\n'`);

      const enterOutput = cli(repo, env, ["send-enter", target]);
      expect(enterOutput).toContain("delivered");
      expect(enterOutput).toContain("Enter");
      await waitForCapture(paneId, `${sendSentinel}-enter`);

      const runOutput = cli(repo, env, ["run", target, "printf", `'${runSentinel}\\n'`]);
      expect(runOutput).toContain("ran");
      expect(runOutput).toContain(target);
      await waitForCapture(paneId, runSentinel);
    } finally {
      run(["tmux", "kill-session", "-t", session], { allowFailure: true, timeout: 2_000 });
      const sessionCheck = run(["tmux", "has-session", "-t", session], { allowFailure: true, timeout: 2_000 });
      expect(sessionCheck.success).toBe(false);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("maw team up and members use real command dispatch and persistent team state", async () => {
    if (!commandAvailable(["tmux", "-V"])) {
      console.warn("SKIP team real-entry smoke: tmux binary is unavailable");
      return;
    }

    const repo = join(import.meta.dir, "..");
    const session = `maw-team-2751-${process.pid}`;
    const team = `team-2751-${process.pid}`;
    const home = mkdtempSync(join(tmpdir(), "maw-team-2751-"));
    const env = smokeEnv(home);

    run(["tmux", "kill-session", "-t", session], { allowFailure: true, timeout: 2_000 });
    try {
      run(["tmux", "new-session", "-d", "-x", "80", "-y", "20", "-s", session, "--", "bash", "-lc", "sleep 120"], { timeout: 5_000 });

      const upOutput = cli(repo, env, ["team", "up", team, "--quick", "1", "--dry-run", "--session", session, "-e", "codex"]);
      expect(upOutput).toContain(`team up: ${team} (${session})`);
      expect(upOutput).toContain("builder-1");
      expect(upOutput).toContain("would fresh wake");
      expect(upOutput).toContain("No changes made");

      const inviteOutput = cli(repo, env, ["team", "oracle-invite", "smoke-oracle", "--team", team, "--role", "scout"]);
      expect(inviteOutput).toContain("smoke-oracle");
      expect(inviteOutput).toContain(team);

      const membersOutput = cli(repo, env, ["team", "members", "--team", team]);
      expect(membersOutput).toContain(`Oracle members of '${team}'`);
      expect(membersOutput).toContain("smoke-oracle");
      expect(membersOutput).toContain("scout");
    } finally {
      run(["tmux", "kill-session", "-t", session], { allowFailure: true, timeout: 2_000 });
      const sessionCheck = run(["tmux", "has-session", "-t", session], { allowFailure: true, timeout: 2_000 });
      expect(sessionCheck.success).toBe(false);
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
