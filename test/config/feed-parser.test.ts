/**
 * Tests for parseLine, activeOracles, describeActivity from src/lib/feed.ts.
 * All pure functions — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import { parseLine, activeOracles, describeActivity } from "../../src/lib/feed";
import type { FeedEvent } from "../../src/lib/feed";

// ─── parseLine ──────────────────────────────────────────────────────────────

describe("parseLine", () => {
  it("parses a full feed line", () => {
    const line = "2026-04-27 10:00:00 | neo | white | PreToolUse | maw-js | sess123 » Bash: ls -la";
    const result = parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.oracle).toBe("neo");
    expect(result!.host).toBe("white");
    expect(result!.event).toBe("PreToolUse");
    expect(result!.project).toBe("maw-js");
    expect(result!.sessionId).toBe("sess123");
    expect(result!.message).toBe("Bash: ls -la");
  });

  it("parses line without message (no » separator)", () => {
    const line = "2026-04-27 10:00:00 | neo | white | SessionStart | maw-js | sess123";
    const result = parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("sess123");
    expect(result!.message).toBe("");
  });

  it("returns null for empty line", () => {
    expect(parseLine("")).toBeNull();
  });

  it("returns null for line without pipe separator", () => {
    expect(parseLine("just some text")).toBeNull();
  });

  it("returns null for line with fewer than 5 parts", () => {
    expect(parseLine("a | b | c | d")).toBeNull();
  });

  it("returns null for invalid timestamp", () => {
    const line = "not-a-date | neo | white | PreToolUse | maw-js | sess123";
    expect(parseLine(line)).toBeNull();
  });

  it("parses timestamp to epoch ms", () => {
    const line = "2026-01-01 00:00:00 | neo | white | PreToolUse | project | sess";
    const result = parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.ts).toBeGreaterThan(0);
    expect(typeof result!.ts).toBe("number");
  });

  it("preserves pipe characters in message after 5th field", () => {
    const line = "2026-04-27 10:00:00 | neo | white | PreToolUse | proj | extra | sess » msg with | pipes";
    const result = parseLine(line);
    expect(result).not.toBeNull();
    // The extra "|" parts get joined into the rest
    expect(result!.message).toContain("pipes");
  });
});

// ─── activeOracles ──────────────────────────────────────────────────────────

describe("activeOracles", () => {
  function makeEvent(oracle: string, tsOffset: number): FeedEvent {
    return {
      timestamp: "2026-04-27 10:00:00",
      oracle,
      host: "white",
      event: "PreToolUse",
      project: "test",
      sessionId: "s1",
      message: "",
      ts: Date.now() + tsOffset,
    };
  }

  it("returns empty map for empty events", () => {
    expect(activeOracles([]).size).toBe(0);
  });

  it("returns active oracles within window", () => {
    const events = [makeEvent("neo", -1000), makeEvent("pulse", -2000)];
    const map = activeOracles(events);
    expect(map.size).toBe(2);
    expect(map.has("neo")).toBe(true);
    expect(map.has("pulse")).toBe(true);
  });

  it("filters out events outside window", () => {
    const events = [
      makeEvent("neo", -1000),
      makeEvent("old", -10 * 60_000), // 10 minutes ago, outside 5-min window
    ];
    const map = activeOracles(events);
    expect(map.has("neo")).toBe(true);
    expect(map.has("old")).toBe(false);
  });

  it("keeps most recent event per oracle", () => {
    const events = [
      { ...makeEvent("neo", -3000), message: "first" },
      { ...makeEvent("neo", -1000), message: "second" },
    ];
    const map = activeOracles(events);
    expect(map.get("neo")!.message).toBe("second");
  });

  it("respects custom window", () => {
    const events = [makeEvent("neo", -2000)];
    // 1 second window — event is 2s ago, should be excluded
    expect(activeOracles(events, 1000).size).toBe(0);
    // 5 second window — event is 2s ago, should be included
    expect(activeOracles(events, 5000).size).toBe(1);
  });
});

// ─── describeActivity ───────────────────────────────────────────────────────

describe("describeActivity", () => {
  function makeEvent(event: string, message: string): FeedEvent {
    return {
      timestamp: "2026-04-27 10:00:00",
      oracle: "neo",
      host: "white",
      event: event as any,
      project: "test",
      sessionId: "s1",
      message,
      ts: Date.now(),
    };
  }

  it("formats PreToolUse with known tool icon", () => {
    const result = describeActivity(makeEvent("PreToolUse", "Bash: ls -la"));
    expect(result).toContain("⚡");
    expect(result).toContain("Bash");
    expect(result).toContain("ls -la");
  });

  it("formats PreToolUse with unknown tool", () => {
    const result = describeActivity(makeEvent("PreToolUse", "CustomTool: stuff"));
    expect(result).toContain("🔧");
    expect(result).toContain("CustomTool");
  });

  it("truncates long PreToolUse details to 60 chars", () => {
    const long = "x".repeat(100);
    const result = describeActivity(makeEvent("PreToolUse", `Bash: ${long}`));
    expect(result.length).toBeLessThan(80);
    expect(result).toContain("...");
  });

  it("formats PostToolUse as done", () => {
    const result = describeActivity(makeEvent("PostToolUse", "Bash ✓"));
    expect(result).toContain("✓");
    expect(result).toContain("done");
  });

  it("formats PostToolUseFailure as failed", () => {
    const result = describeActivity(makeEvent("PostToolUseFailure", "Bash ✗"));
    expect(result).toContain("✗");
    expect(result).toContain("failed");
  });

  it("formats UserPromptSubmit with message", () => {
    const result = describeActivity(makeEvent("UserPromptSubmit", "fix the bug"));
    expect(result).toContain("💬");
    expect(result).toContain("fix the bug");
  });

  it("formats SessionStart", () => {
    expect(describeActivity(makeEvent("SessionStart", ""))).toContain("🟢");
  });

  it("formats SessionEnd", () => {
    expect(describeActivity(makeEvent("SessionEnd", ""))).toContain("⏹");
  });

  it("formats SubagentStart", () => {
    expect(describeActivity(makeEvent("SubagentStart", ""))).toContain("🤖");
  });

  it("formats Notification", () => {
    const result = describeActivity(makeEvent("Notification", "hello"));
    expect(result).toContain("🔔");
    expect(result).toContain("hello");
  });

  it("returns event name for unknown event types", () => {
    const result = describeActivity(makeEvent("PluginLoad", ""));
    expect(result).toBe("PluginLoad");
  });

  it("uses message for unknown event when present", () => {
    const result = describeActivity(makeEvent("PluginLoad", "my-plugin"));
    expect(result).toBe("my-plugin");
  });
});
