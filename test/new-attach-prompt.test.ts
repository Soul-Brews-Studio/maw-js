import { describe, expect, test } from "bun:test";
import {
  decideNewWorkspaceAttach,
  isTruthyEnv,
  validateWorkspaceSessionName,
} from "../src/cli/cmd-new";

describe("decideNewWorkspaceAttach — workspace session factory", () => {
  test("--no-attach beats --attach", () => {
    const d = decideNewWorkspaceAttach({
      attach: true,
      noAttach: true,
      envNoPrompt: false,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    expect(d).toEqual({ action: "skip", reason: "no-attach-flag" });
  });

  test("MAW_NO_PROMPT=1 skips attach", () => {
    const d = decideNewWorkspaceAttach({
      attach: true,
      noAttach: false,
      envNoPrompt: true,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    expect(d).toEqual({ action: "skip", reason: "env-no-prompt" });
  });

  test("interactive TTY defaults to attach/switch", () => {
    const d = decideNewWorkspaceAttach({
      attach: false,
      noAttach: false,
      envNoPrompt: false,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    expect(d).toEqual({ action: "attach", reason: "interactive-tty" });
  });

  test("non-TTY defaults to print-only", () => {
    const d = decideNewWorkspaceAttach({
      attach: false,
      noAttach: false,
      envNoPrompt: false,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });
    expect(d).toEqual({ action: "skip", reason: "non-tty" });
  });
});

describe("maw new workspace validation", () => {
  test("accepts ordinary workspace names", () => {
    expect(() => validateWorkspaceSessionName("my-project_1.dev")).not.toThrow();
  });

  test("rejects shell-shaped or tmux-target-shaped names", () => {
    expect(() => validateWorkspaceSessionName("bad:name")).toThrow();
    expect(() => validateWorkspaceSessionName("../bad")).toThrow();
    expect(() => validateWorkspaceSessionName("-bad")).toThrow();
  });

  test("truthy env helper remains stable", () => {
    expect(isTruthyEnv("1")).toBe(true);
    expect(isTruthyEnv("TRUE")).toBe(true);
    expect(isTruthyEnv("no")).toBe(false);
    expect(isTruthyEnv(undefined)).toBe(false);
  });
});
