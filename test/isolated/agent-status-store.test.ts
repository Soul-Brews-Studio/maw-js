import { describe, test, expect, beforeEach } from "bun:test";
import { AgentStatusStore } from "../../src/core/agent-status";
import type { FeedEvent } from "../../src/lib/feed";

function makeFeedEvent(overrides: Partial<FeedEvent> = {}): FeedEvent {
  return {
    timestamp: new Date().toISOString(),
    oracle: "neo",
    host: "local",
    event: "PreToolUse",
    project: "/test",
    sessionId: "sess-1",
    message: "Bash: ls",
    ts: Date.now(),
    ...overrides,
  };
}

describe("AgentStatusStore", () => {
  let store: AgentStatusStore;

  beforeEach(() => {
    store = new AgentStatusStore();
  });

  test("report() sets status and metadata", () => {
    store.report("neo", "busy", { sessionId: "s1", project: "/p", event: "SessionStart" });
    const entry = store.get("neo");
    expect(entry).toBeDefined();
    expect(entry!.oracle).toBe("neo");
    expect(entry!.status).toBe("busy");
    expect(entry!.sessionId).toBe("s1");
    expect(entry!.project).toBe("/p");
    expect(entry!.lastEvent).toBe("SessionStart");
  });

  test("getAll() returns all entries", () => {
    store.report("neo", "busy");
    store.report("morpheus", "ready");
    store.report("trinity", "idle");
    expect(store.getAll()).toHaveLength(3);
  });

  test("get() returns undefined for unknown oracle", () => {
    expect(store.get("unknown")).toBeUndefined();
  });

  test("remove() deletes an entry", () => {
    store.report("neo", "busy");
    store.remove("neo");
    expect(store.get("neo")).toBeUndefined();
  });

  test("handleFeedEvent() derives busy from SessionStart", () => {
    store.handleFeedEvent(makeFeedEvent({ event: "SessionStart" }));
    expect(store.get("neo")!.status).toBe("busy");
  });

  test("handleFeedEvent() derives busy from UserPromptSubmit", () => {
    store.handleFeedEvent(makeFeedEvent({ event: "UserPromptSubmit" }));
    expect(store.get("neo")!.status).toBe("busy");
  });

  test("handleFeedEvent() derives busy from PreToolUse", () => {
    store.handleFeedEvent(makeFeedEvent({ event: "PreToolUse" }));
    expect(store.get("neo")!.status).toBe("busy");
  });

  test("handleFeedEvent() derives ready from Stop", () => {
    store.handleFeedEvent(makeFeedEvent({ event: "Stop" }));
    expect(store.get("neo")!.status).toBe("ready");
  });

  test("handleFeedEvent() derives idle from SessionEnd", () => {
    store.handleFeedEvent(makeFeedEvent({ event: "SessionEnd" }));
    expect(store.get("neo")!.status).toBe("idle");
  });

  test("handleFeedEvent() ignores non-status events", () => {
    store.handleFeedEvent(makeFeedEvent({ event: "Notification" }));
    expect(store.get("neo")).toBeUndefined();
  });

  test("report() preserves previous sessionId/project when not provided", () => {
    store.report("neo", "busy", { sessionId: "s1", project: "/p" });
    store.report("neo", "ready");
    const entry = store.get("neo")!;
    expect(entry.sessionId).toBe("s1");
    expect(entry.project).toBe("/p");
  });

  test("status transitions: busy → ready → idle", () => {
    store.handleFeedEvent(makeFeedEvent({ event: "SessionStart" }));
    expect(store.get("neo")!.status).toBe("busy");

    store.handleFeedEvent(makeFeedEvent({ event: "Stop" }));
    expect(store.get("neo")!.status).toBe("ready");

    store.handleFeedEvent(makeFeedEvent({ event: "SessionEnd" }));
    expect(store.get("neo")!.status).toBe("idle");
  });

  test("prune() evicts busy/ready entries after active max age", () => {
    const now = Date.now();
    store.report("old-busy", "busy");
    store.report("old-ready", "ready");
    store.report("fresh-busy", "busy");
    store.report("old-idle", "idle");

    store.get("old-busy")!.updatedAt = now - (49 * 60 * 60_000);
    store.get("old-ready")!.updatedAt = now - (49 * 60 * 60_000);
    store.get("fresh-busy")!.updatedAt = now - (47 * 60 * 60_000);
    store.get("old-idle")!.updatedAt = now - (25 * 60 * 60_000);

    expect(store.prune()).toBe(3);
    expect(store.get("old-busy")).toBeUndefined();
    expect(store.get("old-ready")).toBeUndefined();
    expect(store.get("old-idle")).toBeUndefined();
    expect(store.get("fresh-busy")!.status).toBe("busy");
  });
});
