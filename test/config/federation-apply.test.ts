/**
 * Tests for src/commands/shared/federation-apply.ts — applySyncDiff.
 * Pure function: takes current agents + diff, returns new agents + changelog.
 */
import { describe, it, expect } from "bun:test";
import { applySyncDiff } from "../../src/commands/shared/federation-apply";
import type { SyncDiff } from "../../src/commands/shared/federation-identity";

function makeDiff(overrides?: Partial<SyncDiff>): SyncDiff {
  return {
    add: [],
    stale: [],
    conflict: [],
    unreachable: [],
    ...overrides,
  };
}

describe("applySyncDiff", () => {
  it("adds new oracles", () => {
    const diff = makeDiff({ add: [{ oracle: "neo", peerNode: "kc", fromPeer: "kc-peer" }] });
    const { agents, applied } = applySyncDiff({}, diff);
    expect(agents.neo).toBe("kc");
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain("+ agents['neo']");
  });

  it("adds multiple oracles", () => {
    const diff = makeDiff({
      add: [
        { oracle: "neo", peerNode: "kc", fromPeer: "kc-peer" },
        { oracle: "spark", peerNode: "mba", fromPeer: "mba-peer" },
      ],
    });
    const { agents } = applySyncDiff({}, diff);
    expect(agents.neo).toBe("kc");
    expect(agents.spark).toBe("mba");
  });

  it("does not overwrite conflicts without force", () => {
    const diff = makeDiff({
      conflict: [{ oracle: "neo", current: "mba", proposed: "kc", fromPeer: "kc-peer" }],
    });
    const { agents, applied } = applySyncDiff({ neo: "mba" }, diff);
    expect(agents.neo).toBe("mba"); // unchanged
    expect(applied).toHaveLength(0);
  });

  it("overwrites conflicts with force", () => {
    const diff = makeDiff({
      conflict: [{ oracle: "neo", current: "mba", proposed: "kc", fromPeer: "kc-peer" }],
    });
    const { agents, applied } = applySyncDiff({ neo: "mba" }, diff, { force: true });
    expect(agents.neo).toBe("kc"); // overwritten
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain("--force");
  });

  it("does not prune stale without prune flag", () => {
    const diff = makeDiff({
      stale: [{ oracle: "old", peerNode: "kc" }],
    });
    const { agents, applied } = applySyncDiff({ old: "kc" }, diff);
    expect(agents.old).toBe("kc"); // still there
    expect(applied).toHaveLength(0);
  });

  it("prunes stale with prune flag", () => {
    const diff = makeDiff({
      stale: [{ oracle: "old", peerNode: "kc" }],
    });
    const { agents, applied } = applySyncDiff({ old: "kc" }, diff, { prune: true });
    expect(agents.old).toBeUndefined(); // removed
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain("- agents['old']");
  });

  it("preserves existing agents not in diff", () => {
    const diff = makeDiff({ add: [{ oracle: "neo", peerNode: "kc", fromPeer: "kc-peer" }] });
    const { agents } = applySyncDiff({ homekeeper: "local" }, diff);
    expect(agents.homekeeper).toBe("local");
    expect(agents.neo).toBe("kc");
  });

  it("handles empty diff", () => {
    const { agents, applied } = applySyncDiff({ neo: "local" }, makeDiff());
    expect(agents).toEqual({ neo: "local" });
    expect(applied).toEqual([]);
  });

  it("handles combined add + force + prune", () => {
    const diff = makeDiff({
      add: [{ oracle: "new", peerNode: "kc", fromPeer: "kc-peer" }],
      conflict: [{ oracle: "contested", current: "mba", proposed: "kc", fromPeer: "kc-peer" }],
      stale: [{ oracle: "gone", peerNode: "old" }],
    });
    const { agents, applied } = applySyncDiff(
      { contested: "mba", gone: "old", keep: "local" },
      diff,
      { force: true, prune: true },
    );
    expect(agents.new).toBe("kc");
    expect(agents.contested).toBe("kc");
    expect(agents.gone).toBeUndefined();
    expect(agents.keep).toBe("local");
    expect(applied).toHaveLength(3);
  });
});
