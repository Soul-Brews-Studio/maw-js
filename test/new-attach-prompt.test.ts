import { describe, test, expect } from "bun:test";
import {
  decideAttachAction,
  interpretYesNoDefaultYes,
  isTruthyEnv,
  stripCmdNewFlags,
} from "../src/cli/cmd-new";

/**
 * Tests for `maw new` TTY-aware attach prompt (#1272).
 *
 * The flow has three pure pieces that this file exercises directly:
 *
 *   - decideAttachAction(opts)        — pure decision matrix
 *   - interpretYesNoDefaultYes(answer) — default-yes y/N parser
 *   - isTruthyEnv / stripCmdNewFlags   — small helpers
 *
 * cmdNew itself is integration-shaped (invokes the awaken plugin via
 * discoverPackages + invokePlugin) — covered by manual smoke-test in the
 * PR body. Following wake.test.ts convention, we lean on testing the
 * branching helpers rather than mock-poisoning the plugin registry.
 */

const BASE = {
  noAttach: false,
  autoAttach: false,
  envNoPrompt: false,
  stdinIsTTY: true,
  stdoutIsTTY: true,
  creationOk: true,
  alreadyAttached: false,
} as const;

describe("decideAttachAction — priority gates", () => {
  test("creation failed → abort (highest priority)", () => {
    const d = decideAttachAction({ ...BASE, creationOk: false, autoAttach: true });
    expect(d.action).toBe("abort");
  });

  test("already attached → skip with reason 'already-attached'", () => {
    const d = decideAttachAction({ ...BASE, alreadyAttached: true });
    expect(d.action).toBe("skip");
    if (d.action === "skip") expect(d.reason).toBe("already-attached");
  });

  test("--no-attach beats --auto-attach", () => {
    const d = decideAttachAction({ ...BASE, noAttach: true, autoAttach: true });
    expect(d.action).toBe("skip");
    if (d.action === "skip") expect(d.reason).toBe("no-attach-flag");
  });

  test("MAW_NO_PROMPT=1 behaves as --no-attach (skip)", () => {
    const d = decideAttachAction({ ...BASE, envNoPrompt: true });
    expect(d.action).toBe("skip");
    if (d.action === "skip") expect(d.reason).toBe("env-no-prompt");
  });
});

describe("decideAttachAction — TTY branches", () => {
  test("TTY (stdin+stdout) default → prompt", () => {
    const d = decideAttachAction({ ...BASE, stdinIsTTY: true, stdoutIsTTY: true });
    expect(d.action).toBe("prompt");
  });

  test("--auto-attach in TTY → attach without prompt", () => {
    const d = decideAttachAction({ ...BASE, autoAttach: true });
    expect(d.action).toBe("attach");
  });

  test("non-TTY (stdin=false) default → attach silently", () => {
    const d = decideAttachAction({ ...BASE, stdinIsTTY: false, stdoutIsTTY: false });
    expect(d.action).toBe("attach");
  });

  test("non-TTY + --no-attach → skip (script can opt out)", () => {
    const d = decideAttachAction({
      ...BASE,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      noAttach: true,
    });
    expect(d.action).toBe("skip");
  });

  test("stdout TTY but stdin piped → attach (not promptable)", () => {
    // Both must be TTY to prompt — single missing side is non-interactive.
    const d = decideAttachAction({ ...BASE, stdinIsTTY: false, stdoutIsTTY: true });
    expect(d.action).toBe("attach");
  });
});

describe("interpretYesNoDefaultYes", () => {
  test("Enter / empty → yes (default)", () => {
    expect(interpretYesNoDefaultYes("")).toBe(true);
    expect(interpretYesNoDefaultYes("\n")).toBe(true);
    expect(interpretYesNoDefaultYes("   ")).toBe(true);
  });

  test("y / Y / yes / YES → yes", () => {
    expect(interpretYesNoDefaultYes("y")).toBe(true);
    expect(interpretYesNoDefaultYes("Y")).toBe(true);
    expect(interpretYesNoDefaultYes("yes")).toBe(true);
    expect(interpretYesNoDefaultYes("YES\n")).toBe(true);
  });

  test("n / N / no → no", () => {
    expect(interpretYesNoDefaultYes("n")).toBe(false);
    expect(interpretYesNoDefaultYes("N")).toBe(false);
    expect(interpretYesNoDefaultYes("no")).toBe(false);
  });

  test("garbage → no (conservative)", () => {
    expect(interpretYesNoDefaultYes("maybe")).toBe(false);
    expect(interpretYesNoDefaultYes("q")).toBe(false);
  });
});

describe("isTruthyEnv", () => {
  test("truthy values", () => {
    expect(isTruthyEnv("1")).toBe(true);
    expect(isTruthyEnv("true")).toBe(true);
    expect(isTruthyEnv("TRUE")).toBe(true);
    expect(isTruthyEnv("yes")).toBe(true);
    expect(isTruthyEnv("on")).toBe(true);
  });

  test("falsy values", () => {
    expect(isTruthyEnv(undefined)).toBe(false);
    expect(isTruthyEnv("")).toBe(false);
    expect(isTruthyEnv("0")).toBe(false);
    expect(isTruthyEnv("false")).toBe(false);
    expect(isTruthyEnv("no")).toBe(false);
  });
});

describe("stripCmdNewFlags", () => {
  test("strips --no-attach, --auto-attach, -y, --yes", () => {
    const argv = ["foo", "--no-attach", "--from", "neo", "--auto-attach", "-y", "--yes"];
    expect(stripCmdNewFlags(argv)).toEqual(["foo", "--from", "neo"]);
  });

  test("preserves positional args + passthrough flags", () => {
    const argv = ["foo", "--from", "neo", "--seed", "--fast"];
    expect(stripCmdNewFlags(argv)).toEqual(argv);
  });

  test("empty argv → empty", () => {
    expect(stripCmdNewFlags([])).toEqual([]);
  });
});

describe("decideAttachAction — issue acceptance criteria", () => {
  test("`maw new <name>` with TTY → prompts", () => {
    const d = decideAttachAction({ ...BASE });
    expect(d.action).toBe("prompt");
  });

  test("`maw new <name>` without TTY → silent default-attach", () => {
    const d = decideAttachAction({ ...BASE, stdinIsTTY: false, stdoutIsTTY: false });
    expect(d.action).toBe("attach");
  });

  test("--no-attach works as documented", () => {
    const d = decideAttachAction({ ...BASE, noAttach: true });
    expect(d.action).toBe("skip");
  });

  test("--auto-attach / -y skips prompt", () => {
    const d = decideAttachAction({ ...BASE, autoAttach: true });
    expect(d.action).toBe("attach");
  });

  test("MAW_NO_PROMPT=1 = --no-attach semantics", () => {
    // Both should skip.
    const env = decideAttachAction({ ...BASE, envNoPrompt: true });
    const flag = decideAttachAction({ ...BASE, noAttach: true });
    expect(env.action).toBe("skip");
    expect(flag.action).toBe("skip");
  });

  test("creation failed → don't prompt, signal abort", () => {
    const d = decideAttachAction({ ...BASE, creationOk: false });
    expect(d.action).toBe("abort");
  });

  test("already attached to same session → no-op skip", () => {
    const d = decideAttachAction({ ...BASE, alreadyAttached: true });
    expect(d.action).toBe("skip");
  });
});
