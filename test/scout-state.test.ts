import { beforeEach, describe, expect, test } from "bun:test";
import { makeHello } from "../src/transports/scout-protocol";
import { PEER_STALE_MS, SCOUT_INITIAL_MS, SCOUT_MAX_MS, ScoutState } from "../src/transports/scout-state";

describe("scout-state pure state machine", () => {
  const localZid = "ff" + "0".repeat(30);
  let state: ScoutState;

  beforeEach(() => {
    state = new ScoutState(localZid);
  });

  test("backoff advances, caps, and resets", () => {
    expect(state.backoffMs).toBe(SCOUT_INITIAL_MS);
    expect(state.advanceBackoff()).toBe(1000);
    expect(state.backoffMs).toBe(2000);
    for (let i = 0; i < 10; i++) state.advanceBackoff();
    expect(state.backoffMs).toBe(SCOUT_MAX_MS);
    state.resetBackoff();
    expect(state.backoffMs).toBe(SCOUT_INITIAL_MS);
  });

  test("handleHello tracks new peers and ignores self", () => {
    const self = state.handleHello(makeHello({ zid: localZid, node: "self", oracle: "self", locators: [] }), "127.0.0.1");
    expect(self).toEqual({ isNew: false, shouldPair: false });
    expect(state.discoveredPeers.size).toBe(0);

    const hello = makeHello({ zid: "00" + "0".repeat(30), node: "mba", oracle: "neo", locators: ["http://mba:3456"] });
    const first = state.handleHello(hello, "10.0.0.2");
    const second = state.handleHello(hello, "10.0.0.2");
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(state.findPeerByNode("mba")?.host).toBe("10.0.0.2");
  });

  test("GreaterZid pairing policy only pairs when local wins and peer can pair", () => {
    const canPair = state.handleHello(makeHello({
      zid: "00" + "0".repeat(30),
      node: "low",
      oracle: "neo",
      locators: [],
      capabilities: ["pair"],
    }), "10.0.0.1");
    expect(canPair.shouldPair).toBe(true);

    const lowState = new ScoutState("00" + "0".repeat(30));
    const remoteWins = lowState.handleHello(makeHello({
      zid: "ff" + "0".repeat(30),
      node: "high",
      oracle: "neo",
      locators: [],
      capabilities: ["pair"],
    }), "10.0.0.2");
    expect(remoteWins.shouldPair).toBe(false);

    const noCapability = state.handleHello(makeHello({ zid: "01", node: "feed", oracle: "neo", locators: [], capabilities: ["feed"] }), "10.0.0.3");
    expect(noCapability.shouldPair).toBe(false);
  });

  test("pending and paired peers suppress duplicate pairing", () => {
    const zid = "02";
    state.markPending(zid);
    const pending = state.handleHello(makeHello({ zid, node: "pending", oracle: "neo", locators: [], capabilities: ["pair"] }), "10.0.0.4");
    expect(pending.shouldPair).toBe(false);

    state.markPaired(zid);
    expect(state.pendingConnections.has(zid)).toBe(false);
    expect(state.findPeerByZid(zid)?.paired).toBe(true);

    const again = state.handleHello(makeHello({ zid, node: "pending", oracle: "neo", locators: [], capabilities: ["pair"] }), "10.0.0.4");
    expect(again.shouldPair).toBe(false);
  });

  test("peer lookup helpers match node and oracle membership", () => {
    state.handleHello(makeHello({
      zid: "03",
      node: "white",
      oracle: "mawjs",
      locators: [],
      oracles: ["mawjs-oracle", "neo-oracle"],
    }), "10.0.0.5");
    expect(state.findPeerByNode("white")).toBeDefined();
    expect(state.findPeerByOracle("neo")).toBeDefined();
    expect(state.findPeerByZid("03")?.node).toBe("white");
    expect(state.findPeerByOracle("ghost")).toBeUndefined();

    state.markExistingPeerPaired("white");
    expect(state.findPeerByNode("white")?.paired).toBe(true);
    state.clearPending("missing");
  });

  test("pruneStale removes old peers and pending state", () => {
    const zid = "04";
    state.handleHello(makeHello({ zid, node: "old", oracle: "old", locators: [] }), "10.0.0.6");
    state.markPending(zid);
    state.discoveredPeers.get(zid)!.lastSeen = Date.now() - PEER_STALE_MS - 1;
    expect(state.pruneStale()).toEqual(["old"]);
    expect(state.findPeerByZid(zid)).toBeUndefined();
    expect(state.pendingConnections.has(zid)).toBe(false);

    state.handleHello(makeHello({ zid: "05", node: "fresh", oracle: "fresh", locators: [] }), "10.0.0.7");
    expect(state.pruneStale()).toEqual([]);
    expect(state.findPeerByNode("fresh")).toBeDefined();
  });
});
