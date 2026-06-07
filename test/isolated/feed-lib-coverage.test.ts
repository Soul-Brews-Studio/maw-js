/** Targeted isolated coverage for src/lib/feed.ts. */
import { describe, expect, test } from "bun:test";

const { activeOracles, describeActivity, parseLine } = await import("../../src/lib/feed.ts?feed-lib-coverage");
import type { FeedEvent } from "../../src/lib/feed.ts";

function event(overrides: Partial<FeedEvent>): FeedEvent {
  return {
    timestamp: "2026-05-18 12:00:00",
    oracle: "oracle-a",
    host: "m5",
    event: "Notification",
    project: "maw-js",
    sessionId: "s1",
    message: "hello",
    ts: Date.now(),
    ...overrides,
  } as FeedEvent;
}

describe("feed parser", () => {
  test("parseLine rejects malformed and invalid timestamp lines", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("not a feed row")).toBeNull();
    expect(parseLine("2026-05-18 12:00:00 | oracle | host | Event")).toBeNull();
    expect(parseLine("not-a-date | oracle | host | Notification | project | session » message")).toBeNull();
  });

  test("parseLine supports message, no-message fallback, and pipe characters in the tail", () => {
    const parsed = parseLine("2026-05-18 12:34:56 | alpha | m5 | PreToolUse | /repo | sess-1 » Bash: echo a | b");
    expect(parsed).toMatchObject({
      timestamp: "2026-05-18 12:34:56",
      oracle: "alpha",
      host: "m5",
      event: "PreToolUse",
      project: "/repo",
      sessionId: "sess-1",
      message: "Bash: echo a | b",
    });
    expect(parsed?.ts).toBeNumber();

    expect(parseLine("2026-05-18 12:34:56 | beta | white | Stop | /repo | sess-only")).toMatchObject({
      sessionId: "sess-only",
      message: "",
    });
  });
});

describe("feed activity helpers", () => {
  test("activeOracles keeps only recent latest events per oracle", () => {
    const now = Date.now();
    const stale = event({ oracle: "old", ts: now - 10_000 });
    const first = event({ oracle: "alpha", message: "older", ts: now - 800 });
    const latest = event({ oracle: "alpha", message: "latest", ts: now - 100 });
    const beta = event({ oracle: "beta", message: "beta", ts: now - 500 });

    const active = activeOracles([stale, first, beta, latest], 1_000);
    expect([...active.keys()].sort()).toEqual(["alpha", "beta"]);
    expect(active.get("alpha")?.message).toBe("latest");
    expect(active.get("beta")?.message).toBe("beta");
  });

  test("describeActivity renders tool, prompt, lifecycle, notification, and fallback branches", () => {
    expect(describeActivity(event({ event: "PreToolUse", message: "Bash: run a command" }))).toBe("⚡ Bash: run a command");
    expect(describeActivity(event({ event: "PreToolUse", message: `Unknown: ${"x".repeat(65)}` }))).toBe(`🔧 Unknown: ${"x".repeat(57)}...`);
    expect(describeActivity(event({ event: "PreToolUse", message: "Read ✓" }))).toBe("📖 Read");
    expect(describeActivity(event({ event: "PostToolUse", message: "Bash ✓ 0" }))).toBe("✓ Bash done");
    expect(describeActivity(event({ event: "PostToolUseFailure", message: "Edit ✗ failed" }))).toBe("✗ Edit failed");
    expect(describeActivity(event({ event: "UserPromptSubmit", message: "u".repeat(65) }))).toBe(`💬 ${"u".repeat(57)}...`);
    expect(describeActivity(event({ event: "UserPromptSubmit", message: "" }))).toBe("💬 New prompt");
    expect(describeActivity(event({ event: "SubagentStart", message: "" }))).toBe("🤖 Subagent started");
    expect(describeActivity(event({ event: "SubagentStop", message: "" }))).toBe("🤖 Subagent done");
    expect(describeActivity(event({ event: "SessionStart", message: "" }))).toBe("🟢 Session started");
    expect(describeActivity(event({ event: "SessionEnd", message: "" }))).toBe("⏹ Session ended");
    expect(describeActivity(event({ event: "Stop", message: "" }))).toBe("⏹ Stopped");
    expect(describeActivity(event({ event: "Stop", message: "s".repeat(65) }))).toBe(`⏹ ${"s".repeat(57)}...`);
    expect(describeActivity(event({ event: "Notification", message: "ping" }))).toBe("🔔 ping");
    expect(describeActivity(event({ event: "Notification", message: "" }))).toBe("🔔 Notification");
    expect(describeActivity(event({ event: "PluginError", message: "plugin blew up" }))).toBe("plugin blew up");
    expect(describeActivity(event({ event: "PluginLoad", message: "" }))).toBe("PluginLoad");
  });
});
