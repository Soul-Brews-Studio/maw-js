import { describe, it, expect } from "bun:test";
import { formatAgentTable, type LiveAgent } from "../../src/commands/shared/wake-concurrency";

/**
 * #2555 — the cap-reached agent table flags channel listeners so the operator
 * doesn't sleep an idle-but-waiting relay to free a slot. formatAgentTable is
 * pure, so this needs no tmux.
 */
describe("formatAgentTable (#2555) — channel listener flag", () => {
  const base = (over: Partial<LiveAgent>): LiveAgent => ({
    name: "x", target: "01-x:0.0", idleSec: 0, channel: [], ...over,
  });

  it("appends a [ch: …] tag for channel listeners", () => {
    const table = formatAgentTable([
      base({ name: "discord-relay", idleSec: 7200, channel: ["plugin:discord@1"] }),
    ]);
    expect(table).toContain("discord-relay");
    expect(table).toContain("idle");
    expect(table).toContain("📡 [ch: plugin:discord@1]");
  });

  it("omits the tag for non-listeners", () => {
    const table = formatAgentTable([
      base({ name: "codex-oracle", idleSec: 120, channel: [] }),
    ]);
    expect(table).toContain("codex-oracle");
    expect(table).not.toContain("[ch:");
  });

  it("sorts most-idle first (existing behavior preserved)", () => {
    const table = formatAgentTable([
      base({ name: "fresh", idleSec: 5 }),
      base({ name: "stale", idleSec: 9000 }),
    ]);
    expect(table.indexOf("stale")).toBeLessThan(table.indexOf("fresh"));
  });
});
