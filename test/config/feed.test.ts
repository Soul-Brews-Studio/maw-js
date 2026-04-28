/**
 * Tests for parseLine, activeOracles, describeActivity from src/lib/feed.ts.
 * All pure functions — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { parseLine, activeOracles, describeActivity } from "../../src/lib/feed";
import type { FeedEvent } from "../../src/lib/feed";

const makeFeedEvent = (overrides: Partial<FeedEvent> = {}): FeedEvent => ({
  timestamp: "2026-04-27 12:00:00",
  oracle: "neo",
  host: "local",
  event: "PreToolUse",
  project: "maw-js",
  sessionId: "abc123",
  message: "Read: src/index.ts",
  ts: Date.now(),
  ...overrides,
});

describe("parseLine", () => {
  it("parses a well-formed feed line", () => {
    const line =
      "2026-04-27 12:00:00 | neo | local | PreToolUse | maw-js | sess123 » Read: src/index.ts";
    const result = parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.oracle).toBe("neo");
    expect(result!.host).toBe("local");
    expect(result!.event).toBe("PreToolUse");
    expect(result!.project).toBe("maw-js");
    expect(result!.sessionId).toBe("sess123");
    expect(result!.message).toBe("Read: src/index.ts");
  });

  it("returns null for empty line", () => {
    expect(parseLine("")).toBeNull();
  });

  it("returns null for line without pipes", () => {
    expect(parseLine("just a plain string")).toBeNull();
  });

  it("returns null for too few parts", () => {
    expect(parseLine("a | b | c")).toBeNull();
  });

  it("returns null for invalid timestamp", () => {
    const line = "not-a-date | neo | local | PreToolUse | maw-js | sess » msg";
    expect(parseLine(line)).toBeNull();
  });

  it("handles line without » separator", () => {
    const line = "2026-04-27 12:00:00 | neo | local | SessionStart | maw-js | sess123";
    const result = parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("sess123");
    expect(result!.message).toBe("");
  });

  it("parses timestamp to epoch ms", () => {
    const line = "2026-04-27 12:00:00 | neo | local | PreToolUse | maw-js | s » m";
    const result = parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.ts).toBeGreaterThan(0);
    expect(typeof result!.ts).toBe("number");
  });
});

describe("activeOracles", () => {
  it("returns empty map for no events", () => {
    const result = activeOracles([]);
    expect(result.size).toBe(0);
  });

  it("returns oracles within time window", () => {
    const now = Date.now();
    const events: FeedEvent[] = [
      makeFeedEvent({ oracle: "neo", ts: now - 1000 }),
      makeFeedEvent({ oracle: "pulse", ts: now - 2000 }),
    ];
    const result = activeOracles(events, 5 * 60_000);
    expect(result.size).toBe(2);
    expect(result.has("neo")).toBe(true);
    expect(result.has("pulse")).toBe(true);
  });

  it("excludes oracles outside time window", () => {
    const now = Date.now();
    const events: FeedEvent[] = [
      makeFeedEvent({ oracle: "neo", ts: now - 1000 }),
      makeFeedEvent({ oracle: "old", ts: now - 600_000 }),
    ];
    const result = activeOracles(events, 5 * 60_000);
    expect(result.size).toBe(1);
    expect(result.has("neo")).toBe(true);
    expect(result.has("old")).toBe(false);
  });

  it("keeps most recent event per oracle", () => {
    const now = Date.now();
    const events: FeedEvent[] = [
      makeFeedEvent({ oracle: "neo", ts: now - 3000, message: "old" }),
      makeFeedEvent({ oracle: "neo", ts: now - 1000, message: "new" }),
    ];
    const result = activeOracles(events, 5 * 60_000);
    expect(result.size).toBe(1);
    expect(result.get("neo")!.message).toBe("new");
  });

  it("uses default 5-minute window", () => {
    const now = Date.now();
    const events: FeedEvent[] = [
      makeFeedEvent({ oracle: "neo", ts: now - 4 * 60_000 }),
      makeFeedEvent({ oracle: "pulse", ts: now - 6 * 60_000 }),
    ];
    const result = activeOracles(events);
    expect(result.size).toBe(1);
    expect(result.has("neo")).toBe(true);
  });
});

describe("describeActivity", () => {
  it("formats PreToolUse with tool icon", () => {
    const event = makeFeedEvent({ event: "PreToolUse", message: "Read: src/index.ts" });
    const result = describeActivity(event);
    expect(result).toContain("📖");
    expect(result).toContain("Read");
    expect(result).toContain("src/index.ts");
  });

  it("formats PreToolUse with unknown tool", () => {
    const event = makeFeedEvent({ event: "PreToolUse", message: "CustomTool: something" });
    const result = describeActivity(event);
    expect(result).toContain("🔧");
    expect(result).toContain("CustomTool");
  });

  it("truncates long PreToolUse details at 60 chars", () => {
    const longDetail = "a".repeat(100);
    const event = makeFeedEvent({ event: "PreToolUse", message: "Bash: " + longDetail });
    const result = describeActivity(event);
    expect(result).toContain("...");
    expect(result.length).toBeLessThan(80);
  });

  it("formats PreToolUse without colon", () => {
    const event = makeFeedEvent({ event: "PreToolUse", message: "Read ✓" });
    const result = describeActivity(event);
    expect(result).toContain("📖");
    expect(result).toContain("Read");
  });

  it("formats PostToolUse as done", () => {
    const event = makeFeedEvent({ event: "PostToolUse", message: "Read ✓" });
    const result = describeActivity(event);
    expect(result).toContain("✓");
    expect(result).toContain("done");
  });

  it("formats PostToolUseFailure as failed", () => {
    const event = makeFeedEvent({ event: "PostToolUseFailure", message: "Write ✗" });
    const result = describeActivity(event);
    expect(result).toContain("✗");
    expect(result).toContain("failed");
  });

  it("formats UserPromptSubmit", () => {
    const event = makeFeedEvent({ event: "UserPromptSubmit", message: "fix the bug" });
    const result = describeActivity(event);
    expect(result).toContain("💬");
    expect(result).toContain("fix the bug");
  });

  it("truncates long UserPromptSubmit", () => {
    const event = makeFeedEvent({ event: "UserPromptSubmit", message: "x".repeat(100) });
    const result = describeActivity(event);
    expect(result).toContain("...");
  });

  it("formats SubagentStart", () => {
    const event = makeFeedEvent({ event: "SubagentStart" });
    expect(describeActivity(event)).toContain("Subagent started");
  });

  it("formats SubagentStop", () => {
    const event = makeFeedEvent({ event: "SubagentStop" });
    expect(describeActivity(event)).toContain("Subagent done");
  });

  it("formats SessionStart", () => {
    const event = makeFeedEvent({ event: "SessionStart" });
    expect(describeActivity(event)).toContain("Session started");
  });

  it("formats SessionEnd", () => {
    const event = makeFeedEvent({ event: "SessionEnd" });
    expect(describeActivity(event)).toContain("Session ended");
  });

  it("formats Stop with message", () => {
    const event = makeFeedEvent({ event: "Stop", message: "user cancelled" });
    const result = describeActivity(event);
    expect(result).toContain("user cancelled");
  });

  it("formats Notification", () => {
    const event = makeFeedEvent({ event: "Notification", message: "build complete" });
    const result = describeActivity(event);
    expect(result).toContain("🔔");
    expect(result).toContain("build complete");
  });

  it("falls back to message for unknown events", () => {
    const event = makeFeedEvent({ event: "PluginHook" as any, message: "hook fired" });
    expect(describeActivity(event)).toBe("hook fired");
  });

  it("falls back to event name when no message", () => {
    const event = makeFeedEvent({ event: "PluginLoad" as any, message: "" });
    expect(describeActivity(event)).toBe("PluginLoad");
  });
});
