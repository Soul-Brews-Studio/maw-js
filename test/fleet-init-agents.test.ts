import { describe, test, expect } from "bun:test";

// The cmdFleetInitAgents function lives in src/commands/fleet-init.ts and
// depends on loadConfig/saveConfig/loadFleet/fetch — side-effecty stuff we
// don't want to stand up in a unit test. Extract the pure merge logic
// inline here and test it directly. Keep the algorithm identical to the
// real command: additive-only, never overwrite, "local" wins over peer
// attribution when collisions happen via fleet scan, peer attribution
// only adopts entries that peer marked as "local".

interface Peer { name: string; agents: Record<string, string>; }
interface FleetWindow { name: string; }
interface FleetSession { windows: FleetWindow[]; }

function mergeAgents(
  existing: Record<string, string>,
  fleet: FleetSession[],
  peers: Peer[],
): Record<string, string> {
  const proposed: Record<string, string> = { ...existing };

  for (const sess of fleet) {
    for (const w of sess.windows || []) {
      if (!w?.name) continue;
      if (!(w.name in proposed)) proposed[w.name] = "local";
    }
  }

  for (const peer of peers) {
    for (const [name, host] of Object.entries(peer.agents)) {
      if (host === "local" && !(name in proposed)) proposed[name] = peer.name;
    }
  }

  return proposed;
}

describe("fleet init --agents (#215)", () => {
  test("adds missing local fleet windows to agents map", () => {
    const existing = {};
    const fleet: FleetSession[] = [
      { windows: [{ name: "pulse-oracle" }, { name: "neo-oracle" }] },
      { windows: [{ name: "mawjs-oracle" }] },
    ];
    const result = mergeAgents(existing, fleet, []);
    expect(result).toEqual({
      "pulse-oracle": "local",
      "neo-oracle": "local",
      "mawjs-oracle": "local",
    });
  });

  test("preserves existing user-set entries — never overwrites", () => {
    const existing = {
      // user manually pinned volt to mba (maybe it's on a different host)
      volt: "mba",
      // local override that should not be replaced even though fleet says "local"
      "pulse-oracle": "white",
    };
    const fleet: FleetSession[] = [
      { windows: [{ name: "pulse-oracle" }, { name: "neo-oracle" }] },
    ];
    const result = mergeAgents(existing, fleet, []);
    expect(result.volt).toBe("mba");               // untouched
    expect(result["pulse-oracle"]).toBe("white");  // not replaced with "local"
    expect(result["neo-oracle"]).toBe("local");    // new, added
  });

  test("adopts peer's local agents under peer.name", () => {
    const existing = {};
    const fleet: FleetSession[] = [];
    const peers: Peer[] = [
      {
        name: "white",
        agents: {
          pulse: "local",
          floodboy: "local",
          fireman: "local",
          // peer's view of ANOTHER peer — should NOT be adopted, shapes drift
          homekeeper: "mba",
        },
      },
    ];
    const result = mergeAgents(existing, fleet, peers);
    expect(result).toEqual({
      pulse: "white",
      floodboy: "white",
      fireman: "white",
      // homekeeper: "mba" NOT copied — we only trust each peer for what it owns
    });
  });

  test("local wins over peer attribution when both present", () => {
    const existing = {};
    const fleet: FleetSession[] = [
      { windows: [{ name: "mawjs-oracle" }] },
    ];
    const peers: Peer[] = [
      {
        name: "white",
        // white ALSO claims mawjs-oracle (it exists on both nodes as a bud)
        agents: { "mawjs-oracle": "local" },
      },
    ];
    const result = mergeAgents(existing, fleet, peers);
    // Local scan runs first, so mawjs-oracle gets "local" and the peer
    // adoption loop skips it because it's already present.
    expect(result["mawjs-oracle"]).toBe("local");
  });

  test("multi-peer merge without collisions", () => {
    const existing = {};
    const fleet: FleetSession[] = [
      { windows: [{ name: "mawjs-oracle" }] },
    ];
    const peers: Peer[] = [
      { name: "white", agents: { pulse: "local", floodboy: "local" } },
      { name: "mba", agents: { homekeeper: "local", vpnkeeper: "local" } },
      { name: "clinic-nat", agents: { neo: "local" } },
    ];
    const result = mergeAgents(existing, fleet, peers);
    expect(result).toEqual({
      "mawjs-oracle": "local",
      pulse: "white",
      floodboy: "white",
      homekeeper: "mba",
      vpnkeeper: "mba",
      neo: "clinic-nat",
    });
  });

  test("handles empty peers and empty fleet (no-op)", () => {
    const existing = { already: "here" };
    const result = mergeAgents(existing, [], []);
    expect(result).toEqual({ already: "here" });
  });

  test("skips windows with missing name gracefully", () => {
    const existing = {};
    const fleet: FleetSession[] = [
      { windows: [{ name: "" }, { name: "pulse-oracle" }] },
      // @ts-expect-error — intentionally malformed window to exercise the guard
      { windows: [{ name: null }] },
    ];
    const result = mergeAgents(existing, fleet, []);
    // Only the valid window is added; empty/null are skipped.
    expect(result).toEqual({ "pulse-oracle": "local" });
  });
});
