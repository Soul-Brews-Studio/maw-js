/**
 * Regression tests for #356 — maw update --help must NOT uninstall maw.
 *
 * Bug: `maw update --help` ran `bun remove -g maw` before printing help,
 *      bricking the installation. Same class as #349 (restart --help).
 * Fix: cli.ts checks --help/-h before any execSync calls in the update branch.
 *
 * Strategy: spawn cli.ts as a subprocess (it's a top-level script, not a module).
 * A clean exit + help text in stdout proves the fix held. Any bun-remove output
 * in stdout/stderr would indicate a regression.
 */
import { describe, it, expect } from "bun:test";
import { runBunChild } from "./isolated/helpers/run-bun-child";

const cmdUpdateUrl = new URL("../src/cli/cmd-update.ts", import.meta.url).href;

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runBunChild({
    cwd: process.cwd(),
    env: { MAW_CLI: "1", MAW_TEST_MODE: "1" },
    script: `
      const { runUpdate } = await import(${JSON.stringify(cmdUpdateUrl)});
      await runUpdate(${JSON.stringify(args)});
    `,
  });
}

describe("#356 — maw update --help short-circuits before uninstalling maw", () => {
  it("--help exits 0 with usage text", async () => {
    const { code, stdout } = await runCli(["update", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("usage: maw update");
    expect(stdout).toContain("--help");
  }, 10_000);

  it("--help output contains no destructive bun-remove evidence", async () => {
    const { stdout, stderr } = await runCli(["update", "--help"]);
    const combined = stdout + stderr;
    // bun remove -g maw would print something like "removed maw" or "bun remove"
    expect(combined).not.toMatch(/bun remove|removed maw/i);
  }, 10_000);

  it("-h shorthand also exits 0 with usage text", async () => {
    const { code, stdout } = await runCli(["update", "-h"]);
    expect(code).toBe(0);
    expect(stdout).toContain("usage: maw update");
  }, 10_000);

  it("flag-looking ref (e.g. --notaflag) is rejected with exit 1, not installed", async () => {
    const { code, stderr } = await runCli(["update", "--notaflag"]);
    expect(code).toBe(1);
    expect(stderr).toContain("invalid ref");
    expect(stderr).toContain("--notaflag");
  }, 10_000);
});
