/**
 * Tests for src/commands/shared/federation-diff.ts — computeSyncDiff.
 * Pure function: takes local agents + peer identities, returns diff.
 */
import { describe, it, expect } from "bun:test";
import { computeSyncDiff } from "../../src/commands/shared/federation-diff";
import type { PeerIdentity } from "../../src/commands/shared/federation-identity";

function peer(name: string, node: string, agents: string[], reachable = true): PeerIdentity {
  return { peerName: name, url: `http://${name}:3456`, node, agents, reachable, error: reachable ? undefined : "timeout" };
}

describe("computeSyncDiff", () => {
  it("returns empty diff when no peers", () => {
    const diff = computeSyncDiff({ neo: "local" }, [], "white");
    expect(diff.add).toEqual([]);
    expect(diff.stale).toEqual([]);
    expect(diff.conflict).toEqual([]);
    expect(diff.unreachable).toEqual([]);
  });

  it("adds new oracles from reachable peer", () => {
    const diff = computeSyncDiff({}, [peer("kc-peer", "kc", ["neo", "spark"])], "white");
    expect(diff.add).toHaveLength(2);
    expect(diff.add[0].oracle).toBe("neo");
    expect(diff.add[0].peerNode).toBe("kc");
  });

  it("skips already-routed oracles", () => {
    const diff = computeSyncDiff({ neo: "kc" }, [peer("kc-peer", "kc", ["neo"])], "white");
    expect(diff.add).toEqual([]);
  });

  it("detects stale routes (oracle no longer on peer)", () => {
    const diff = computeSyncDiff(
      { neo: "kc", old: "kc" },
      [peer("kc-peer", "kc", ["neo"])], // "old" is missing from kc's agents
      "white",
    );
    expect(diff.stale).toHaveLength(1);
    expect(diff.stale[0].oracle).toBe("old");
  });

  it("does not flag local routes as stale", () => {
    const diff = computeSyncDiff(
      { neo: "local" },
      [peer("kc-peer", "kc", [])],
      "white",
    );
    expect(diff.stale).toEqual([]);
  });

  it("does not flag self-node routes as stale", () => {
    const diff = computeSyncDiff(
      { neo: "white" },
      [peer("kc-peer", "kc", [])],
      "white",
    );
    expect(diff.stale).toEqual([]);
  });

  it("detects conflicts (oracle routed to different node)", () => {
    const diff = computeSyncDiff(
      { neo: "mba" },
      [peer("kc-peer", "kc", ["neo"])],
      "white",
    );
    expect(diff.conflict).toHaveLength(1);
    expect(diff.conflict[0].current).toBe("mba");
    expect(diff.conflict[0].proposed).toBe("kc");
  });

  it("tracks unreachable peers", () => {
    const diff = computeSyncDiff({}, [peer("down", "kc", ["neo"], false)], "white");
    expect(diff.unreachable).toHaveLength(1);
    expect(diff.unreachable[0].peerName).toBe("down");
    expect(diff.add).toEqual([]);
  });

  it("skips oracles from unreachable peers (no add, no stale)", () => {
    const diff = computeSyncDiff(
      { neo: "kc" },
      [peer("kc-peer", "kc", ["neo"], false)],
      "white",
    );
    expect(diff.stale).toEqual([]);
    expect(diff.add).toEqual([]);
  });

  it("first peer wins on duplicate node", () => {
    const diff = computeSyncDiff(
      {},
      [
        peer("first", "kc", ["neo"]),
        peer("second", "kc", ["spark"]),
      ],
      "white",
    );
    // Only "neo" added (from first peer), "spark" from second peer ignored (duplicate node)
    expect(diff.add).toHaveLength(1);
    expect(diff.add[0].oracle).toBe("neo");
  });

  it("first peer wins on cross-node oracle claim", () => {
    const diff = computeSyncDiff(
      {},
      [
        peer("kc-peer", "kc", ["neo"]),
        peer("mba-peer", "mba", ["neo"]),
      ],
      "white",
    );
    expect(diff.add).toHaveLength(1);
    expect(diff.add[0].peerNode).toBe("kc");
  });
});
