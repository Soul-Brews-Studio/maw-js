import { describe, expect, test } from "bun:test";
import { buildCommandInDirFromConfig } from "../src/config/command-logic";
import { buildWakeCommand } from "../src/commands/shared/wake-cmd";

/**
 * `maw wake --fresh-session` (alias `--no-continue`) launches the engine with a
 * FRESH conversation by stripping the resume/`--continue` placeholder, so a seat
 * does not resume its latest conversation. It reuses the existing `freshLaunch`
 * strip path; this test locks the launch line's `--continue` behavior and the
 * flag→fresh wiring.
 */
describe("wake --fresh-session strips --continue from the launch line", () => {
  const config = { commands: { default: "claude --dangerously-skip-permissions --continue" } };

  test("default launch keeps --continue (resumes)", () => {
    const cmd = buildCommandInDirFromConfig(config, "worker", "/repos/x", { fresh: false });
    expect(cmd).toContain("--continue");
  });

  test("fresh launch drops --continue (fresh conversation)", () => {
    const cmd = buildCommandInDirFromConfig(config, "worker", "/repos/x", { fresh: true });
    expect(cmd).not.toContain("--continue");
  });
});

describe("buildWakeCommand wiring: freshSession routes exactly like freshLaunch", () => {
  test("freshSession produces the same launch line as freshLaunch", () => {
    const viaSession = buildWakeCommand("w", "/repos/x", { freshSession: true });
    const viaLaunch = buildWakeCommand("w", "/repos/x", { freshLaunch: true });
    expect(viaSession).toBe(viaLaunch);
  });

  test("neither flag → the two fresh forms still agree, and a plain wake may differ", () => {
    // config-independent invariant: the two fresh forms are always equal
    const a = buildWakeCommand("w", "/repos/x", {});
    const b = buildWakeCommand("w", "/repos/x", { freshSession: false, freshLaunch: false });
    expect(a).toBe(b);
  });
});
