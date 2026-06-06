import { describe, test, expect } from "bun:test";
import { zshSnippet } from "../../src/vendor/mpr-plugins/shellenv/src/snippets/zsh";

describe("shellenv zsh claude() wrapper (#1896)", () => {
  const snippet = zshSnippet();

  test("includes --dangerously-skip-permissions by default", () => {
    expect(snippet).toContain("--dangerously-skip-permissions");
  });

  test("includes MAW_CLAUDE_CHANNELS env-driven default", () => {
    expect(snippet).toContain("MAW_CLAUDE_CHANNELS-plugin:discord@claude-plugins-official");
  });

  test("preserves --continue fallback chain", () => {
    // Fallback: when claude exits non-zero with --continue (no prior session),
    // retry with --continue stripped. Both halves appear; the OR is the chain.
    expect(snippet).toContain("|| command claude");
    expect(snippet).toContain("--continue");
  });

  test("claude46/claude47 still delegate to claude() (inherit new flags)", () => {
    expect(snippet).toMatch(/claude46\(\)\s*\{[\s\S]*?ANTHROPIC_MODEL="claude-opus-4-6\[1m\]" claude/);
    expect(snippet).toMatch(/claude47\(\)\s*\{[\s\S]*?ANTHROPIC_MODEL="claude-opus-4-7" claude/);
  });

  test("disables --channels when MAW_CLAUDE_CHANNELS is set empty (runtime check via [[ -n ]])", () => {
    expect(snippet).toMatch(/\[\[ -n "\$channels" \]\] && opts\+=\(--channels/);
  });
});
