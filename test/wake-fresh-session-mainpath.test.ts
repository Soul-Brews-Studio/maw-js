import { describe, expect, test } from "bun:test";
import { invokeDirectHandler } from "../src/cli/top-aliases";
import { buildCommandInDirFromConfig } from "../src/config/command-logic";

/**
 * Live-disproven regression (pilot #7 follow-up): `maw wake maw-maint
 * --fresh-session` still launched `claude --dangerously-skip-permissions
 * --continue` (ps proof). The `wake`/`awake` aliases dispatch through the DIRECT
 * fast path (top-aliases `invokeDirectHandler`), whose own parseFlags list did
 * not declare `--fresh-session`/`--no-continue`. parseFlags is permissive, so
 * the flag fell into `flags._` and was dropped — cmdWake never saw
 * `freshSession`, and the main window kept `--continue`. (The plugin path and the
 * manifest validator both handled the flag; only this direct parse was missed.)
 *
 * These tests assert the flag now reaches core AND that the REAL main-window
 * command form (what buildWakeCommand builds — `fresh` → strip `--continue`)
 * carries no `--continue`.
 */

/** Capture the opts the direct wake handler hands to cmdWake. */
async function captureWakeOpts(argv: string[]): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  await invokeDirectHandler("../commands/shared/wake-cmd:cmdWake", argv, {
    cmdWake: (_oracle: string, opts: Record<string, unknown>) => { captured = opts; },
    // Keep the engine-shorthand scan a no-op so no real config is loaded.
    loadConfig: () => ({ commands: {} }),
    log: () => {},
    error: () => {},
  });
  return captured;
}

describe("wake alias direct path propagates --fresh-session to cmdWake", () => {
  test("--fresh-session sets opts.freshSession = true", async () => {
    const opts = await captureWakeOpts(["maw-maint", "--fresh-session"]);
    expect(opts.freshSession).toBe(true);
  });

  test("--no-continue (alias) sets opts.freshSession = true", async () => {
    const opts = await captureWakeOpts(["maw-maint", "--no-continue"]);
    expect(opts.freshSession).toBe(true);
  });

  test("no flag → freshSession stays unset (baseline: still resumes)", async () => {
    const opts = await captureWakeOpts(["maw-maint"]);
    expect(opts.freshSession).toBeUndefined();
  });
});

describe("the REAL main-window command reflects the propagated flag", () => {
  // buildWakeCommand maps opts.freshSession → `fresh` and calls
  // buildCommandInDir(win, cwd, { fresh }); this is that exact command form.
  const config = { commands: { default: "claude --dangerously-skip-permissions --continue" } };

  test("--fresh-session → main-window command has NO --continue", async () => {
    const opts = await captureWakeOpts(["maw-maint", "--fresh-session"]);
    const command = buildCommandInDirFromConfig(config, "maw-maint", "/repos/x", { fresh: !!opts.freshSession });
    expect(command).not.toContain("--continue");
  });

  test("no flag → main-window command still has --continue", async () => {
    const opts = await captureWakeOpts(["maw-maint"]);
    const command = buildCommandInDirFromConfig(config, "maw-maint", "/repos/x", { fresh: !!opts.freshSession });
    expect(command).toContain("--continue");
  });
});
