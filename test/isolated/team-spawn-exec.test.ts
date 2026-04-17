import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { cmdTeamSpawn } from "../../src/commands/plugins/team/team-lifecycle";

// Regression test for #393 Bug C — `maw team spawn --exec` is the opt-in
// flag that auto-launches claude in a new tmux pane. Default behavior
// (write prompt file + print claude command) is preserved.
//
// Tests focus on the FALLBACK branch (no $TMUX) since the actual tmux
// split would consume real resources. The fallback-message path is also
// the one most likely to silently break.

let testDir: string;
let originalCwd: string;
let originalTMUX: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  originalTMUX = process.env.TMUX;
  testDir = mkdtempSync(join(tmpdir(), "maw-bugC-"));
  // Oracle root markers for resolvePsi
  mkdirSync(join(testDir, "ψ/memory/mailbox/teams/test-team"), { recursive: true });
  writeFileSync(join(testDir, "CLAUDE.md"), "# test oracle\n");
  writeFileSync(
    join(testDir, "ψ/memory/mailbox/teams/test-team/manifest.json"),
    JSON.stringify({ name: "test-team", members: [], description: "test" })
  );
  process.chdir(testDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalTMUX === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTMUX;
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
});

async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
  try { await fn(); } finally { console.log = origLog; }
  return logs;
}

describe("cmdTeamSpawn — #393 Bug C — --exec opt-in", () => {
  test("default (no --exec): prints 'Run: claude ...' line", async () => {
    delete process.env.TMUX;
    const logs = await captureLogs(() => cmdTeamSpawn("test-team", "probe", { prompt: "test" }));
    const joined = logs.join("\n");
    expect(joined).toContain("Run:");
    expect(joined).toContain("claude --model");
    expect(joined).toContain("--prompt-file");
    // Should NOT mention --exec since we didn't pass it
    expect(joined).not.toContain("--exec");
  });

  test("--exec without TMUX: clear warning + fallback to manual run", async () => {
    delete process.env.TMUX;
    const logs = await captureLogs(() => cmdTeamSpawn("test-team", "probe", { exec: true, prompt: "test" }));
    const joined = logs.join("\n");
    expect(joined).toContain("--exec requires an active tmux session");
    expect(joined).toContain("Run manually");
    expect(joined).toContain("claude --model");
    // Should NOT have a success line since exec couldn't run
    expect(joined).not.toContain("✓ --exec");
  });

  test("default writes prompt file regardless of --exec", async () => {
    delete process.env.TMUX;
    await cmdTeamSpawn("test-team", "probe", { prompt: "smoke" });
    const promptPath = join(testDir, "ψ/memory/mailbox/teams/test-team/probe-spawn-prompt.md");
    expect(existsSync(promptPath)).toBe(true);
  });

  test("--exec also writes prompt file (even when split fails)", async () => {
    delete process.env.TMUX;
    await cmdTeamSpawn("test-team", "probe", { exec: true, prompt: "smoke" });
    const promptPath = join(testDir, "ψ/memory/mailbox/teams/test-team/probe-spawn-prompt.md");
    expect(existsSync(promptPath)).toBe(true);
  });

  test("model defaults to sonnet when not specified", async () => {
    delete process.env.TMUX;
    const logs = await captureLogs(() => cmdTeamSpawn("test-team", "probe", { prompt: "test" }));
    const joined = logs.join("\n");
    expect(joined).toContain("model: sonnet");
    expect(joined).toContain("--model sonnet");
  });

  test("custom model is passed through to the claude command", async () => {
    delete process.env.TMUX;
    const logs = await captureLogs(() => cmdTeamSpawn("test-team", "probe", { model: "opus", prompt: "test" }));
    const joined = logs.join("\n");
    expect(joined).toContain("model: opus");
    expect(joined).toContain("--model opus");
  });

  test("manifest gets updated with new member name", async () => {
    delete process.env.TMUX;
    await cmdTeamSpawn("test-team", "alpha-agent", { prompt: "test" });
    const manifest = JSON.parse(
      require("fs").readFileSync(join(testDir, "ψ/memory/mailbox/teams/test-team/manifest.json"), "utf-8")
    );
    expect(manifest.members).toContain("alpha-agent");
  });
});
