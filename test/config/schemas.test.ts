/**
 * Tests for src/lib/schemas.ts — TypeBox schema validation.
 *
 * Validates that schemas accept correct shapes and reject malformed data.
 */
import { describe, it, expect } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  Identity, Peer, FederationStatus, Session, FeedEvent,
  PluginInfo, WakeBody, SleepBody, SendBody,
  ConfigFileBody, TriggerFireBody, TransportSendBody,
} from "../../src/lib/schemas";

describe("Identity schema", () => {
  it("accepts valid identity", () => {
    expect(Value.Check(Identity, {
      node: "white",
      version: "2026.4.2",
      agents: ["neo", "homekeeper"],
      clockUtc: "2026-04-27T10:00:00Z",
      uptime: 3600,
    })).toBe(true);
  });

  it("rejects missing node", () => {
    expect(Value.Check(Identity, {
      version: "1.0", agents: [], clockUtc: "", uptime: 0,
    })).toBe(false);
  });
});

describe("Peer schema", () => {
  it("accepts minimal peer", () => {
    expect(Value.Check(Peer, { url: "http://kc:3456", reachable: true })).toBe(true);
  });

  it("accepts full peer with optional fields", () => {
    expect(Value.Check(Peer, {
      url: "http://kc:3456", reachable: true,
      latency: 42, node: "kc", agents: ["neo"],
      clockDeltaMs: 100, clockWarning: false,
    })).toBe(true);
  });

  it("rejects missing reachable", () => {
    expect(Value.Check(Peer, { url: "http://kc:3456" })).toBe(false);
  });
});

describe("Session schema", () => {
  it("accepts valid session", () => {
    expect(Value.Check(Session, {
      name: "maw",
      windows: [{ index: 0, name: "neo", active: true }],
    })).toBe(true);
  });

  it("accepts session with source", () => {
    expect(Value.Check(Session, {
      name: "maw", source: "local",
      windows: [],
    })).toBe(true);
  });

  it("rejects window without index", () => {
    expect(Value.Check(Session, {
      name: "maw",
      windows: [{ name: "neo", active: true }],
    })).toBe(false);
  });
});

describe("FeedEvent schema", () => {
  it("accepts valid event", () => {
    expect(Value.Check(FeedEvent, {
      timestamp: "2026-04-27T10:00:00Z",
      oracle: "neo",
      host: "local",
      event: "SubagentStart",
      project: "maw-js",
      sessionId: "abc-123",
      message: "started",
    })).toBe(true);
  });

  it("rejects missing oracle", () => {
    expect(Value.Check(FeedEvent, {
      timestamp: "", host: "", event: "", project: "", sessionId: "", message: "",
    })).toBe(false);
  });
});

describe("WakeBody schema", () => {
  it("accepts with target only", () => {
    expect(Value.Check(WakeBody, { target: "neo" })).toBe(true);
  });

  it("accepts with target + task", () => {
    expect(Value.Check(WakeBody, { target: "neo", task: "review PR" })).toBe(true);
  });

  it("rejects empty object", () => {
    expect(Value.Check(WakeBody, {})).toBe(false);
  });
});

describe("SleepBody schema", () => {
  it("accepts valid", () => {
    expect(Value.Check(SleepBody, { target: "neo" })).toBe(true);
  });

  it("rejects missing target", () => {
    expect(Value.Check(SleepBody, {})).toBe(false);
  });
});

describe("SendBody schema", () => {
  it("accepts with target + text", () => {
    expect(Value.Check(SendBody, { target: "neo", text: "hello" })).toBe(true);
  });

  it("accepts with force flag", () => {
    expect(Value.Check(SendBody, { target: "neo", text: "hello", force: true })).toBe(true);
  });

  it("rejects missing text", () => {
    expect(Value.Check(SendBody, { target: "neo" })).toBe(false);
  });
});

describe("ConfigFileBody schema", () => {
  it("accepts content string", () => {
    expect(Value.Check(ConfigFileBody, { content: '{"host":"local"}' })).toBe(true);
  });

  it("rejects missing content", () => {
    expect(Value.Check(ConfigFileBody, {})).toBe(false);
  });
});

describe("TriggerFireBody schema", () => {
  it("accepts event only", () => {
    expect(Value.Check(TriggerFireBody, { event: "cron" })).toBe(true);
  });

  it("accepts event + context", () => {
    expect(Value.Check(TriggerFireBody, {
      event: "pr-merge",
      context: { repo: "maw-js", pr: "42" },
    })).toBe(true);
  });

  it("rejects missing event", () => {
    expect(Value.Check(TriggerFireBody, {})).toBe(false);
  });
});

describe("TransportSendBody schema", () => {
  it("accepts minimal", () => {
    expect(Value.Check(TransportSendBody, { oracle: "neo", message: "hello" })).toBe(true);
  });

  it("accepts with optional host + from", () => {
    expect(Value.Check(TransportSendBody, {
      oracle: "neo", message: "hello", host: "kc", from: "boom",
    })).toBe(true);
  });

  it("rejects missing message", () => {
    expect(Value.Check(TransportSendBody, { oracle: "neo" })).toBe(false);
  });
});
