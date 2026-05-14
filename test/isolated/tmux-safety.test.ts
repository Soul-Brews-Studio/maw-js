import { describe, test, expect } from "bun:test";
import { checkDestructive, isClaudeLikePane, isFleetOrViewSession } from "../../src/commands/core/tmux/safety";

// Pure unit tests for the safety module (#395 maw tmux send/kill prereq).
// No mocks — everything is deterministic input → deterministic output.

describe("checkDestructive — deny-list patterns", () => {
  const cases: Array<[string, boolean, string?]> = [
    ["ls -la", false],
    ["echo hello", false],
    ["date", false],
    ["pwd && cd /", true, "&&"], // && triggers chain (intentional)
    ["rm file.txt", true, "rm"],
    ["rm -rf /tmp/junk", true, "rm"],
    ["sudo apt update", true, "sudo"],
    ["echo > /etc/passwd", true, ">"],
    ["echo >> ~/.bashrc", true, ">>"],
    ["cat file ; echo done", true, ";"],
    ["test && rm -f", true, "&&"],
    ["cat file | grep x", true, "|"],
    ["git reset --hard HEAD", true, "reset"],
    ["git push --force origin main", true, "push --force"],
    ["git clean -fd", true, "clean"],
    ["gh repo delete foo/bar", true, "gh delete"],
    ["kill -9 12345", true, "kill -9"],
    ["DROP TABLE users", true, "drop"],
    ["drop table users", true, "drop"],
    ["echo 'rm trick'", true, "rm in quotes still matches (defense over precision)"],
  ];

  for (const [cmd, expectedDestructive, label] of cases) {
    test(`"${cmd}" → ${expectedDestructive ? "destructive" : "safe"}${label ? ` (${label})` : ""}`, () => {
      const r = checkDestructive(cmd);
      expect(r.destructive).toBe(expectedDestructive);
      if (expectedDestructive) expect(r.reasons.length).toBeGreaterThan(0);
      else expect(r.reasons.length).toBe(0);
    });
  }

  test("multiple patterns surface multiple reasons", () => {
    const r = checkDestructive("sudo rm -rf /");
    expect(r.destructive).toBe(true);
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });

  test("empty string is safe", () => {
    expect(checkDestructive("").destructive).toBe(false);
  });
});

describe("isClaudeLikePane — pane-running-claude detection", () => {
  test("'claude' direct match", () => {
    expect(isClaudeLikePane("claude")).toBe(true);
  });

  test("'CLAUDE' case-insensitive", () => {
    expect(isClaudeLikePane("CLAUDE")).toBe(true);
  });

  test("substring 'bun ... claude ...'", () => {
    expect(isClaudeLikePane("bun run claude")).toBe(true);
  });

  test("version-string '2.1.111' (claude wrapper) → claude-like", () => {
    expect(isClaudeLikePane("2.1.111")).toBe(true);
  });

  test("'2.0.0-alpha.105' is NOT claude-like (semver, not pure)", () => {
    expect(isClaudeLikePane("2.0.0-alpha.105")).toBe(false);
  });

  test("'bash' is not claude", () => {
    expect(isClaudeLikePane("bash")).toBe(false);
  });

  test("'vim' is not claude", () => {
    expect(isClaudeLikePane("vim")).toBe(false);
  });

  test("undefined → false (defensive default — no claim without info)", () => {
    expect(isClaudeLikePane(undefined)).toBe(false);
  });

  test("empty string → false", () => {
    expect(isClaudeLikePane("")).toBe(false);
  });
});

describe("isFleetOrViewSession — fleet/view safety check (Bug F lineage)", () => {
  const fleet = new Set(["101-mawjs", "112-fusion", "114-mawjs-no2"]);

  test("fleet session matches", () => {
    expect(isFleetOrViewSession("101-mawjs", fleet)).toBe(true);
  });

  test("legacy maw-view literal matches", () => {
    expect(isFleetOrViewSession("maw-view", fleet)).toBe(true);
  });

  test("per-oracle *-view matches", () => {
    expect(isFleetOrViewSession("mawjs-view", fleet)).toBe(true);
    expect(isFleetOrViewSession("fusion-view", fleet)).toBe(true);
  });

  test("non-fleet, non-view session does NOT match (kill is allowed)", () => {
    expect(isFleetOrViewSession("random-session", fleet)).toBe(false);
  });

  test("view-prefixed session does NOT match (suffix-only, safety: don't over-protect)", () => {
    expect(isFleetOrViewSession("view-something", fleet)).toBe(false);
  });

  test("empty fleet, but maw-view still protected", () => {
    expect(isFleetOrViewSession("maw-view", new Set())).toBe(true);
    expect(isFleetOrViewSession("anything-view", new Set())).toBe(true);
  });
});
