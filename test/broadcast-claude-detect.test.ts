import { describe, test, expect } from "bun:test";
import { isClaudeLikePane } from "../src/commands/plugins/tmux/safety";

describe("isClaudeLikePane — Claude Code pane detection", () => {
  test("matches 'claude'", () => {
    expect(isClaudeLikePane("claude")).toBe(true);
  });

  test("matches 'Claude' (case-insensitive)", () => {
    expect(isClaudeLikePane("Claude")).toBe(true);
  });

  test("matches version string '2.1.202' (Claude Code v2.1.202+)", () => {
    expect(isClaudeLikePane("2.1.202")).toBe(true);
  });

  test("matches version with whitespace", () => {
    expect(isClaudeLikePane("  2.1.202\n")).toBe(true);
  });

  test("matches other semver patterns", () => {
    expect(isClaudeLikePane("3.0.0")).toBe(true);
    expect(isClaudeLikePane("10.20.300")).toBe(true);
  });

  test("rejects shell commands", () => {
    expect(isClaudeLikePane("zsh")).toBe(false);
    expect(isClaudeLikePane("bash")).toBe(false);
    expect(isClaudeLikePane("fish")).toBe(false);
  });

  test("rejects other programs", () => {
    expect(isClaudeLikePane("vim")).toBe(false);
    expect(isClaudeLikePane("node")).toBe(false);
    expect(isClaudeLikePane("tmux")).toBe(false);
  });

  test("rejects undefined/empty", () => {
    expect(isClaudeLikePane(undefined)).toBe(false);
    expect(isClaudeLikePane("")).toBe(false);
    expect(isClaudeLikePane("   ")).toBe(false);
  });
});
