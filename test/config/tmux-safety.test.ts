/**
 * Tests for src/commands/plugins/tmux/safety.ts — checkDestructive, isClaudeLikePane, isFleetOrViewSession.
 * Pure functions, no tmux/network.
 */
import { describe, it, expect } from "bun:test";
import { checkDestructive, isClaudeLikePane, isFleetOrViewSession } from "../../src/commands/plugins/tmux/safety";

// ─── checkDestructive ────────────────────────────────────────────

describe("checkDestructive", () => {
  it("detects rm", () => {
    const r = checkDestructive("rm -rf /tmp/test");
    expect(r.destructive).toBe(true);
    expect(r.reasons.some(r => r.includes("rm"))).toBe(true);
  });

  it("detects sudo", () => {
    expect(checkDestructive("sudo apt install").destructive).toBe(true);
  });

  it("detects redirect", () => {
    expect(checkDestructive("echo x > file.txt").destructive).toBe(true);
  });

  it("detects pipe", () => {
    expect(checkDestructive("cat file | grep x").destructive).toBe(true);
  });

  it("detects git reset --hard", () => {
    expect(checkDestructive("git reset --hard HEAD~1").destructive).toBe(true);
  });

  it("detects git push --force", () => {
    expect(checkDestructive("git push origin main --force").destructive).toBe(true);
  });

  it("detects kill -9", () => {
    expect(checkDestructive("kill -9 12345").destructive).toBe(true);
  });

  it("detects DROP TABLE (case insensitive)", () => {
    expect(checkDestructive("DROP TABLE users").destructive).toBe(true);
    expect(checkDestructive("drop table users").destructive).toBe(true);
  });

  it("returns multiple reasons for compound commands", () => {
    const r = checkDestructive("sudo rm -rf /; echo done");
    expect(r.destructive).toBe(true);
    expect(r.reasons.length).toBeGreaterThan(1);
  });

  it("passes safe commands", () => {
    expect(checkDestructive("ls -la").destructive).toBe(false);
    expect(checkDestructive("cat README.md").destructive).toBe(false);
    expect(checkDestructive("git status").destructive).toBe(false);
    expect(checkDestructive("echo hello").destructive).toBe(false);
  });

  it("returns empty reasons for safe commands", () => {
    expect(checkDestructive("git log").reasons).toEqual([]);
  });
});

// ─── isClaudeLikePane ────────────────────────────────────────────

describe("isClaudeLikePane", () => {
  it("detects claude", () => {
    expect(isClaudeLikePane("claude")).toBe(true);
  });

  it("detects claude with args", () => {
    expect(isClaudeLikePane("claude --dangerously-skip-permissions")).toBe(true);
  });

  it("detects bun ... claude wrapper", () => {
    expect(isClaudeLikePane("bun x claude")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(isClaudeLikePane("Claude")).toBe(true);
  });

  it("detects version-like pattern", () => {
    expect(isClaudeLikePane("2.1.111")).toBe(true);
  });

  it("rejects undefined/empty", () => {
    expect(isClaudeLikePane(undefined)).toBe(false);
    expect(isClaudeLikePane("")).toBe(false);
  });

  it("rejects non-claude commands", () => {
    expect(isClaudeLikePane("zsh")).toBe(false);
    expect(isClaudeLikePane("bash")).toBe(false);
    expect(isClaudeLikePane("vim")).toBe(false);
  });
});

// ─── isFleetOrViewSession ────────────────────────────────────────

describe("isFleetOrViewSession", () => {
  const fleet = new Set(["maw", "neo", "pim"]);

  it("detects fleet session", () => {
    expect(isFleetOrViewSession("neo", fleet)).toBe(true);
  });

  it("detects maw-view", () => {
    expect(isFleetOrViewSession("maw-view", fleet)).toBe(true);
  });

  it("detects *-view suffix", () => {
    expect(isFleetOrViewSession("custom-view", fleet)).toBe(true);
  });

  it("rejects non-fleet non-view", () => {
    expect(isFleetOrViewSession("random", fleet)).toBe(false);
  });

  it("rejects view in middle", () => {
    expect(isFleetOrViewSession("viewer", fleet)).toBe(false);
  });
});
