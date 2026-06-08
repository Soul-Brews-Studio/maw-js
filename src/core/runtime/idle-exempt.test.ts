import { describe, it, expect } from "bun:test";
import {
  CHANNEL_LISTENER_EXEMPT,
  DEFAULT_AGENT_IDLE_SLEEP_TRIGGER,
  isAgentExemptFromTrigger,
} from "./idle-exempt";

/**
 * #2555 — channel-aware exemption for agent-idle triggers.
 *
 * `isAgentExemptFromTrigger` is pure: the channel-membership probe is injected
 * so these tests need no tmux, feed, or real channel config.
 */
describe("isAgentExemptFromTrigger (#2555)", () => {
  const listener = (a: string) => a === "discord-relay";

  it("not exempt when the trigger declares no exemptions", () => {
    expect(isAgentExemptFromTrigger({}, "discord-relay", listener)).toBe(false);
    expect(isAgentExemptFromTrigger({ exempt: [] }, "discord-relay", listener)).toBe(false);
  });

  it("not exempt when the agent is not a channel listener", () => {
    expect(isAgentExemptFromTrigger({ exempt: [CHANNEL_LISTENER_EXEMPT] }, "codex-oracle", listener)).toBe(false);
  });

  it("exempt when the trigger opts in AND the agent is a channel listener", () => {
    expect(isAgentExemptFromTrigger({ exempt: [CHANNEL_LISTENER_EXEMPT] }, "discord-relay", listener)).toBe(true);
  });

  it("ignores unrelated exemption tags", () => {
    expect(isAgentExemptFromTrigger({ exempt: ["something-else"] }, "discord-relay", listener)).toBe(false);
  });

  it("never exempts an empty agent name", () => {
    expect(isAgentExemptFromTrigger({ exempt: [CHANNEL_LISTENER_EXEMPT] }, "", listener)).toBe(false);
  });
});

describe("DEFAULT_AGENT_IDLE_SLEEP_TRIGGER (#2555) — opt-in, not auto-enabled", () => {
  it("is a 5-minute agent-idle sleep trigger that exempts channel listeners", () => {
    expect(DEFAULT_AGENT_IDLE_SLEEP_TRIGGER.on).toBe("agent-idle");
    expect(DEFAULT_AGENT_IDLE_SLEEP_TRIGGER.timeout).toBe(300);
    expect(DEFAULT_AGENT_IDLE_SLEEP_TRIGGER.action).toBe("maw sleep {agent}");
    expect(DEFAULT_AGENT_IDLE_SLEEP_TRIGGER.exempt).toEqual([CHANNEL_LISTENER_EXEMPT]);
  });

  it("a channel listener is shielded by the default trigger", () => {
    const isListener = (a: string) => a === "discord-relay";
    expect(isAgentExemptFromTrigger(DEFAULT_AGENT_IDLE_SLEEP_TRIGGER, "discord-relay", isListener)).toBe(true);
    expect(isAgentExemptFromTrigger(DEFAULT_AGENT_IDLE_SLEEP_TRIGGER, "codex-oracle", isListener)).toBe(false);
  });
});
