/**
 * Tests for pure check functions from src/commands/shared/fleet-doctor-checks.ts.
 * All functions are pure (no I/O) — no mocking needed.
 */
import { describe, it, expect } from "bun:test";
import {
  checkCollisions,
  checkMissingAgents,
  checkOrphanRoutes,
  checkDuplicatePeers,
  checkSelfPeer,
} from "../../src/commands/shared/fleet-doctor-checks";

describe("checkCollisions", () => {
  it("returns empty for no sessions or peers", () => {
    expect(checkCollisions([], [])).toEqual([]);
  });

  it("allows exact match (not a collision)", () => {
    expect(checkCollisions(["white"], ["white"])).toEqual([]);
  });

  it("allows NN-peer form", () => {
    expect(checkCollisions(["105-white"], ["white"])).toEqual([]);
  });

  it("detects substring collision", () => {
    const result = checkCollisions(["whitekeeper"], ["white"]);
    expect(result).toHaveLength(1);
    expect(result[0].check).toBe("collision");
    expect(result[0].level).toBe("error");
    expect(result[0].message).toContain("#239");
  });

  it("is case-insensitive", () => {
    const result = checkCollisions(["WhiteKeeper"], ["white"]);
    expect(result).toHaveLength(1);
  });

  it("skips empty peer names", () => {
    expect(checkCollisions(["session"], [""])).toEqual([]);
  });

  it("detects multiple collisions", () => {
    const result = checkCollisions(["whitekeeper", "blacksmith"], ["white", "black"]);
    expect(result).toHaveLength(2);
  });
});

describe("checkMissingAgents", () => {
  it("returns empty when no peer agents", () => {
    expect(checkMissingAgents({}, {})).toEqual([]);
  });

  it("returns empty when all agents mapped", () => {
    expect(checkMissingAgents({ neo: "remote" }, { remote: ["neo"] })).toEqual([]);
  });

  it("detects unmapped agent", () => {
    const result = checkMissingAgents({}, { remote: ["neo-oracle"] });
    expect(result).toHaveLength(1);
    expect(result[0].check).toBe("missing-agent");
    expect(result[0].fixable).toBe(true);
    expect(result[0].detail!.oracle).toBe("neo-oracle");
    expect(result[0].detail!.peerNode).toBe("remote");
  });

  it("detects multiple missing across peers", () => {
    const result = checkMissingAgents({}, {
      peer1: ["oracle-a"],
      peer2: ["oracle-b", "oracle-c"],
    });
    expect(result).toHaveLength(3);
  });
});

describe("checkOrphanRoutes", () => {
  it("returns empty for no agents", () => {
    expect(checkOrphanRoutes({}, [], "local")).toEqual([]);
  });

  it("passes when agent points to local node", () => {
    expect(checkOrphanRoutes({ neo: "my-node" }, [], "my-node")).toEqual([]);
  });

  it("passes when agent points to known peer", () => {
    expect(checkOrphanRoutes({ neo: "remote" }, ["remote"], "local")).toEqual([]);
  });

  it("passes when agent points to 'local'", () => {
    expect(checkOrphanRoutes({ neo: "local" }, [], "my-node")).toEqual([]);
  });

  it("detects orphan route", () => {
    const result = checkOrphanRoutes({ neo: "unknown-node" }, ["peer1"], "my-node");
    expect(result).toHaveLength(1);
    expect(result[0].check).toBe("orphan-route");
    expect(result[0].level).toBe("error");
    expect(result[0].fixable).toBe(false);
  });
});

describe("checkDuplicatePeers", () => {
  it("returns empty for no peers", () => {
    expect(checkDuplicatePeers([])).toEqual([]);
  });

  it("returns empty for unique peers", () => {
    const result = checkDuplicatePeers([
      { name: "a", url: "http://a:3456" },
      { name: "b", url: "http://b:3456" },
    ]);
    expect(result).toEqual([]);
  });

  it("detects duplicate names", () => {
    const result = checkDuplicatePeers([
      { name: "same", url: "http://a:3456" },
      { name: "same", url: "http://b:3456" },
    ]);
    expect(result.some(f => f.detail!.kind === "name")).toBe(true);
  });

  it("detects duplicate URLs", () => {
    const result = checkDuplicatePeers([
      { name: "a", url: "http://same:3456" },
      { name: "b", url: "http://same:3456" },
    ]);
    expect(result.some(f => f.detail!.kind === "url")).toBe(true);
  });

  it("all duplicates are fixable", () => {
    const result = checkDuplicatePeers([
      { name: "x", url: "http://x:1" },
      { name: "x", url: "http://x:1" },
    ]);
    for (const f of result) expect(f.fixable).toBe(true);
  });
});

describe("checkSelfPeer", () => {
  it("returns empty for no peers", () => {
    expect(checkSelfPeer([], "local", 3456)).toEqual([]);
  });

  it("detects self-peer by name", () => {
    const result = checkSelfPeer(
      [{ name: "my-node", url: "http://remote:9999" }],
      "my-node",
      3456,
    );
    expect(result).toHaveLength(1);
    expect(result[0].check).toBe("self-peer");
    expect(result[0].detail!.reason).toBe("name");
  });

  it("detects self-peer by localhost URL", () => {
    const result = checkSelfPeer(
      [{ name: "other", url: "http://localhost:3456" }],
      "my-node",
      3456,
    );
    expect(result).toHaveLength(1);
    expect(result[0].detail!.reason).toBe("url");
  });

  it("detects self-peer by 127.0.0.1", () => {
    const result = checkSelfPeer(
      [{ name: "other", url: "http://127.0.0.1:3456" }],
      "",
      3456,
    );
    expect(result).toHaveLength(1);
  });

  it("detects self-peer by 0.0.0.0", () => {
    const result = checkSelfPeer(
      [{ name: "other", url: "http://0.0.0.0:3456" }],
      "",
      3456,
    );
    expect(result).toHaveLength(1);
  });

  it("passes for remote peer on different port", () => {
    const result = checkSelfPeer(
      [{ name: "other", url: "http://localhost:9999" }],
      "my-node",
      3456,
    );
    expect(result).toEqual([]);
  });

  it("passes for real remote peer", () => {
    const result = checkSelfPeer(
      [{ name: "remote", url: "http://other-machine:3456" }],
      "my-node",
      3456,
    );
    expect(result).toEqual([]);
  });

  it("self-peer findings are fixable", () => {
    const result = checkSelfPeer(
      [{ name: "my-node", url: "http://x:1" }],
      "my-node",
      3456,
    );
    expect(result[0].fixable).toBe(true);
  });
});
