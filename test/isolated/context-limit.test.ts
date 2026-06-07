import { describe, expect, test } from "bun:test";
import {
  checkPaneContextLimit,
  compactIfPaneContextLimited,
  waitForPaneContextLimit,
  isContextLimitOutput,
  isLikelyAgentPaneCommand,
} from "../../src/commands/shared/context-limit";

describe("context-limit pane detection (#1746)", () => {
  test("recognizes Claude context-limit prompts", () => {
    expect(isContextLimitOutput("Context limit reached · /compact or /clear to continue")).toBe(true);
    expect(isContextLimitOutput("please compact or clear to continue")).toBe(true);
    expect(isContextLimitOutput("ordinary agent output")).toBe(false);
    expect(isContextLimitOutput("")).toBe(false);
  });

  test("only agent-like commands are probed by maw ls", () => {
    expect(isLikelyAgentPaneCommand("claude")).toBe(true);
    expect(isLikelyAgentPaneCommand("codex")).toBe(true);
    expect(isLikelyAgentPaneCommand("node")).toBe(true);
    expect(isLikelyAgentPaneCommand("2.1.111")).toBe(true);
    expect(isLikelyAgentPaneCommand("zsh")).toBe(false);
  });

  test("checks captured pane output", async () => {
    expect(await checkPaneContextLimit("anon:digger", {
      capture: async () => "Context limit reached · /compact or /clear to continue",
    })).toBe(true);
    expect(await checkPaneContextLimit("anon:digger", {
      capture: async () => "ready",
    })).toBe(false);
  });

  test("sends /compact once a frozen pane is detected", async () => {
    const sent: Array<{ target: string; text: string }> = [];
    const recovered = await compactIfPaneContextLimited("anon:digger", {
      pollMs: 0,
      capture: async () => "Context limit reached",
      sendText: async (target, text) => { sent.push({ target, text }); },
      warn: () => {},
    });

    expect(recovered).toBe(true);
    expect(sent).toEqual([{ target: "anon:digger", text: "/compact" }]);
  });

  test("treats capture failures as non-frozen and polls with default sleep", async () => {
    expect(await checkPaneContextLimit("anon:digger", {
      capture: async () => { throw new Error("capture failed"); },
    })).toBe(false);

    const times = [0, 0, 2];
    let captures = 0;
    const frozen = await waitForPaneContextLimit("anon:digger", {
      pollMs: 1,
      intervalMs: 50,
      now: () => times.shift() ?? 2,
      capture: async () => {
        captures++;
        return "ready";
      },
    });

    expect(frozen).toBe(false);
    expect(captures).toBeGreaterThan(1);
  });

  test("returns false when a frozen pane cannot be compacted", async () => {
    const recovered = await compactIfPaneContextLimited("anon:digger", {
      pollMs: 0,
      capture: async () => "ordinary output",
      sendText: async () => { throw new Error("should not send"); },
    });

    expect(recovered).toBe(false);
  });

});
