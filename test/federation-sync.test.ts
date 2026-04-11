import { describe, test, expect } from "bun:test";
import {
  computeSyncDiff,
  applySyncDiff,
  hostedAgents,
  type PeerIdentity,
} from "../src/commands/federation-sync";

/**
 * federation-sync splits I/O (fetchPeerIdentities, cmdFederationSync)
 * from pure logic (computeSyncDiff, applySyncDiff). These tests cover
 * the pure layer exhaustively — no network, no filesystem, no mocks.
 */

function mkPeer(
  peerName: string,
  node: string,
  agents: string[],
  reachable = true,
): PeerIdentity {
  return {
    peerName,
    url: `http://${peerName}:3456`,
    node,
    agents,
    reachable,
    error: reachable ? undefined : "stub",
  };
}

describe("hostedAgents — /api/identity filter", () => {
  test("explicit node-name entries are included", () => {
    expect(
      hostedAgents({ pulse: "white", mawjs: "white", foo: "mba" }, "white").sort(),
    ).toEqual(["mawjs", "pulse"]);
  });

  test("'local' entries are included (regression: 2026-04-11)", () => {
    // Before the fix, 'local' entries were silently dropped from /api/identity,
    // causing peers to false-flag the oracle as stale during federation sync.
    expect(
      hostedAgents({ "volt-colab-ml": "local", mawjs: "white" }, "white").sort(),
    ).toEqual(["mawjs", "volt-colab-ml"]);
  });

  test("mixed local + node-name + foreign is handled", () => {
    expect(
      hostedAgents(
        {
          boonkeeper: "local",
          mawjs: "oracle-world",
          homekeeper: "mba",
          volt: "mba",
          pulse: "white",
        },
        "oracle-world",
      ).sort(),
    ).toEqual(["boonkeeper", "mawjs"]);
  });

  test("empty agents map → empty list", () => {
    expect(hostedAgents({}, "white")).toEqual([]);
  });

  test("foreign routes are excluded", () => {
    expect(hostedAgents({ neo: "clinic-nat", volt: "mba" }, "white")).toEqual([]);
  });
});

describe("computeSyncDiff — add", () => {
  test("new oracle on a reachable peer is added", () => {
    const diff = computeSyncDiff(
      {},
      [mkPeer("white", "white", ["mawjs", "volt-colab-ml"])],
      "oracle-world",
    );
    expect(diff.add.map((a) => a.oracle).sort()).toEqual(["mawjs", "volt-colab-ml"]);
    expect(diff.conflict).toEqual([]);
    expect(diff.stale).toEqual([]);
    expect(diff.unreachable).toEqual([]);
  });

  test("already-routed oracle is not added", () => {
    const diff = computeSyncDiff(
      { mawjs: "white" },
      [mkPeer("white", "white", ["mawjs"])],
      "oracle-world",
    );
    expect(diff.add).toEqual([]);
    expect(diff.conflict).toEqual([]);
  });

  test("oracle routed to 'local' is left alone even if peer also claims it", () => {
    const diff = computeSyncDiff(
      { mawjs: "local" },
      [mkPeer("white", "white", ["mawjs"])],
      "oracle-world",
    );
    expect(diff.add).toEqual([]);
    expect(diff.conflict).toEqual([]);
  });

  test("oracle routed to the local node is treated like 'local'", () => {
    const diff = computeSyncDiff(
      { mawjs: "oracle-world" },
      [mkPeer("white", "white", ["mawjs"])],
      "oracle-world",
    );
    expect(diff.add).toEqual([]);
    expect(diff.conflict).toEqual([]);
  });
});

describe("computeSyncDiff — conflict", () => {
  test("same oracle routed locally elsewhere is a conflict", () => {
    const diff = computeSyncDiff(
      { mawjs: "mba" },
      [mkPeer("white", "white", ["mawjs"])],
      "oracle-world",
    );
    expect(diff.conflict.length).toBe(1);
    expect(diff.conflict[0]).toEqual({
      oracle: "mawjs",
      current: "mba",
      proposed: "white",
      fromPeer: "white",
    });
  });

  test("two peers claiming the same oracle → first peer wins", () => {
    const diff = computeSyncDiff(
      {},
      [
        mkPeer("white", "white", ["ghost"]),
        mkPeer("mba", "mba", ["ghost"]),
      ],
      "oracle-world",
    );
    expect(diff.add.length).toBe(1);
    expect(diff.add[0].peerNode).toBe("white");
    expect(diff.conflict).toEqual([]);
  });
});

describe("computeSyncDiff — stale", () => {
  test("route to reachable peer where oracle no longer exists → stale", () => {
    const diff = computeSyncDiff(
      { oldGuy: "white" },
      [mkPeer("white", "white", ["mawjs"])],
      "oracle-world",
    );
    expect(diff.stale).toEqual([{ oracle: "oldGuy", peerNode: "white" }]);
  });

  test("route to UNREACHABLE peer is NOT stale (we can't prove it's gone)", () => {
    const diff = computeSyncDiff(
      { oldGuy: "mba" },
      [mkPeer("mba", "mba", [], false)],
      "oracle-world",
    );
    expect(diff.stale).toEqual([]);
    expect(diff.unreachable.length).toBe(1);
  });

  test("'local' routes are never stale", () => {
    const diff = computeSyncDiff(
      { mawjs: "local" },
      [mkPeer("white", "white", [])],
      "oracle-world",
    );
    expect(diff.stale).toEqual([]);
  });

  test("routes pointing at localNode are never stale", () => {
    const diff = computeSyncDiff(
      { mawjs: "oracle-world" },
      [mkPeer("white", "white", [])],
      "oracle-world",
    );
    expect(diff.stale).toEqual([]);
  });
});

describe("computeSyncDiff — unreachable tracking", () => {
  test("unreachable peers are reported separately, not dropped silently", () => {
    const diff = computeSyncDiff(
      {},
      [
        mkPeer("white", "white", ["mawjs"]),
        mkPeer("mba", "mba", [], false),
      ],
      "oracle-world",
    );
    expect(diff.add.length).toBe(1);
    expect(diff.unreachable.length).toBe(1);
    expect(diff.unreachable[0].peerName).toBe("mba");
  });

  test("all unreachable → no adds, all tracked", () => {
    const diff = computeSyncDiff(
      { mawjs: "local" },
      [
        mkPeer("white", "white", [], false),
        mkPeer("mba", "mba", [], false),
      ],
      "oracle-world",
    );
    expect(diff.add).toEqual([]);
    expect(diff.stale).toEqual([]);
    expect(diff.conflict).toEqual([]);
    expect(diff.unreachable.length).toBe(2);
  });
});

describe("computeSyncDiff — tonight's scenarios", () => {
  test("mawui's catch: volt-colab-ml visible on white, absent from agents map", () => {
    const diff = computeSyncDiff(
      { mawjs: "local", homekeeper: "mba" },
      [mkPeer("white", "white", ["mawjs", "volt-colab-ml", "pulse"])],
      "oracle-world",
    );
    const added = diff.add.map((a) => a.oracle).sort();
    // mawjs is already routed to 'local' → skipped
    expect(added).toEqual(["pulse", "volt-colab-ml"]);
  });

  test("full triangle sync: two live peers + one dead", () => {
    const diff = computeSyncDiff(
      { mawjs: "local", volt: "white" },
      [
        mkPeer("white", "white", ["mawjs", "volt", "pulse"]),
        mkPeer("mba", "mba", ["homekeeper", "netkeeper"]),
        mkPeer("clinic", "clinic-nat", [], false),
      ],
      "oracle-world",
    );
    // Adds from white: pulse (mawjs is local, volt already routed)
    // Adds from mba: homekeeper, netkeeper
    expect(diff.add.map((a) => a.oracle).sort()).toEqual([
      "homekeeper",
      "netkeeper",
      "pulse",
    ]);
    expect(diff.unreachable.length).toBe(1);
    expect(diff.unreachable[0].peerName).toBe("clinic");
  });
});

describe("applySyncDiff — transforms agents map", () => {
  test("adds from diff.add, preserves other entries", () => {
    const { agents, applied } = applySyncDiff(
      { mawjs: "local" },
      {
        add: [{ oracle: "pulse", peerNode: "white", fromPeer: "white" }],
        stale: [],
        conflict: [],
        unreachable: [],
      },
    );
    expect(agents).toEqual({ mawjs: "local", pulse: "white" });
    expect(applied.length).toBe(1);
    expect(applied[0]).toContain("pulse");
    expect(applied[0]).toContain("white");
  });

  test("without --force, conflicts are NOT applied", () => {
    const { agents, applied } = applySyncDiff(
      { mawjs: "mba" },
      {
        add: [],
        stale: [],
        conflict: [{ oracle: "mawjs", current: "mba", proposed: "white", fromPeer: "white" }],
        unreachable: [],
      },
    );
    expect(agents).toEqual({ mawjs: "mba" }); // unchanged
    expect(applied).toEqual([]);
  });

  test("with --force, conflicts ARE applied", () => {
    const { agents, applied } = applySyncDiff(
      { mawjs: "mba" },
      {
        add: [],
        stale: [],
        conflict: [{ oracle: "mawjs", current: "mba", proposed: "white", fromPeer: "white" }],
        unreachable: [],
      },
      { force: true },
    );
    expect(agents).toEqual({ mawjs: "white" });
    expect(applied.length).toBe(1);
    expect(applied[0]).toContain("'mba'");
    expect(applied[0]).toContain("'white'");
    expect(applied[0]).toContain("--force");
  });

  test("without --prune, stale entries are NOT removed", () => {
    const { agents, applied } = applySyncDiff(
      { oldGuy: "white" },
      {
        add: [],
        stale: [{ oracle: "oldGuy", peerNode: "white" }],
        conflict: [],
        unreachable: [],
      },
    );
    expect(agents).toEqual({ oldGuy: "white" });
    expect(applied).toEqual([]);
  });

  test("with --prune, stale entries ARE removed", () => {
    const { agents, applied } = applySyncDiff(
      { oldGuy: "white", mawjs: "local" },
      {
        add: [],
        stale: [{ oracle: "oldGuy", peerNode: "white" }],
        conflict: [],
        unreachable: [],
      },
      { prune: true },
    );
    expect(agents).toEqual({ mawjs: "local" });
    expect(applied.length).toBe(1);
    expect(applied[0]).toContain("oldGuy");
  });

  test("add + force + prune combine correctly", () => {
    const { agents, applied } = applySyncDiff(
      { mawjs: "mba", oldGuy: "white" },
      {
        add: [{ oracle: "pulse", peerNode: "white", fromPeer: "white" }],
        conflict: [{ oracle: "mawjs", current: "mba", proposed: "white", fromPeer: "white" }],
        stale: [{ oracle: "oldGuy", peerNode: "white" }],
        unreachable: [],
      },
      { force: true, prune: true },
    );
    expect(agents).toEqual({ mawjs: "white", pulse: "white" });
    expect(applied.length).toBe(3);
  });

  test("empty diff → no changes", () => {
    const { agents, applied } = applySyncDiff(
      { mawjs: "local" },
      { add: [], stale: [], conflict: [], unreachable: [] },
    );
    expect(agents).toEqual({ mawjs: "local" });
    expect(applied).toEqual([]);
  });
});
