import { describe, it, expect, beforeEach } from "bun:test";
import { ScoutState, SCOUT_INITIAL_MS, SCOUT_MAX_MS, PEER_STALE_MS } from "./scout-state";
import { generateZid, makeHello } from "./scout-protocol";

describe("scout-state", () => {
  let state: ScoutState;
  const localZid = "ff" + "0".repeat(30); // high zid — will always be initiator

  beforeEach(() => {
    state = new ScoutState(localZid);
  });

  describe("backoff", () => {
    it("starts at SCOUT_INITIAL_MS", () => {
      expect(state.backoffMs).toBe(SCOUT_INITIAL_MS);
    });

    it("doubles on each advance", () => {
      expect(state.advanceBackoff()).toBe(1000);
      expect(state.backoffMs).toBe(2000);
      expect(state.advanceBackoff()).toBe(2000);
      expect(state.backoffMs).toBe(4000);
      expect(state.advanceBackoff()).toBe(4000);
      expect(state.backoffMs).toBe(8000);
    });

    it("caps at SCOUT_MAX_MS", () => {
      for (let i = 0; i < 10; i++) state.advanceBackoff();
      expect(state.backoffMs).toBe(SCOUT_MAX_MS);
    });

    it("resets to initial on resetBackoff()", () => {
      state.advanceBackoff();
      state.advanceBackoff();
      state.resetBackoff();
      expect(state.backoffMs).toBe(SCOUT_INITIAL_MS);
    });
  });

  describe("handleHello", () => {
    it("detects new peer", () => {
      const hello = makeHello({
        zid: "00" + "0".repeat(30),
        node: "mba",
        oracle: "neo",
        locators: ["http://192.168.1.10:3456"],
      });
      const result = state.handleHello(hello, "192.168.1.10");
      expect(result.isNew).toBe(true);
      expect(state.discoveredPeers.size).toBe(1);
    });

    it("returns isNew=false for known peer", () => {
      const zid = "00" + "0".repeat(30);
      const hello = makeHello({ zid, node: "mba", oracle: "neo", locators: ["http://x:3456"] });
      state.handleHello(hello, "192.168.1.10");
      const result = state.handleHello(hello, "192.168.1.10");
      expect(result.isNew).toBe(false);
    });

    it("ignores self", () => {
      const hello = makeHello({ zid: localZid, node: "self", oracle: "self", locators: [] });
      const result = state.handleHello(hello, "127.0.0.1");
      expect(result.isNew).toBe(false);
      expect(result.shouldPair).toBe(false);
      expect(state.discoveredPeers.size).toBe(0);
    });

    it("resets backoff on new peer", () => {
      state.advanceBackoff();
      state.advanceBackoff();
      expect(state.backoffMs).toBe(4000);

      const hello = makeHello({
        zid: generateZid(),
        node: "new",
        oracle: "new",
        locators: ["http://x:3456"],
      });
      state.handleHello(hello, "10.0.0.1");
      expect(state.backoffMs).toBe(SCOUT_INITIAL_MS);
    });

    it("updates lastSeen on repeated hello", () => {
      const zid = "00" + "0".repeat(30);
      const hello = makeHello({ zid, node: "mba", oracle: "neo", locators: ["http://x:3456"] });

      state.handleHello(hello, "192.168.1.10");
      const firstSeen = state.discoveredPeers.get(zid)!.lastSeen;

      // tiny delay to ensure timestamp differs
      const later = makeHello({ zid, node: "mba", oracle: "neo", locators: ["http://x:3456"] });
      state.handleHello(later, "192.168.1.10");
      expect(state.discoveredPeers.get(zid)!.lastSeen).toBeGreaterThanOrEqual(firstSeen);
    });
  });

  describe("GreaterZid pairing", () => {
    it("shouldPair=true when local zid > remote zid and peer has pair capability", () => {
      const remoteZid = "00" + "0".repeat(30);
      const hello = makeHello({
        zid: remoteZid,
        node: "mba",
        oracle: "neo",
        locators: ["http://x:3456"],
        capabilities: ["pair", "feed", "send"],
      });
      const result = state.handleHello(hello, "10.0.0.1");
      expect(result.shouldPair).toBe(true);
    });

    it("shouldPair=false when local zid < remote zid", () => {
      const lowState = new ScoutState("00" + "0".repeat(30));
      const hello = makeHello({
        zid: "ff" + "0".repeat(30),
        node: "mba",
        oracle: "neo",
        locators: ["http://x:3456"],
        capabilities: ["pair"],
      });
      const result = lowState.handleHello(hello, "10.0.0.1");
      expect(result.shouldPair).toBe(false);
    });

    it("shouldPair=false when peer lacks pair capability", () => {
      const hello = makeHello({
        zid: "00" + "0".repeat(30),
        node: "mba",
        oracle: "neo",
        locators: ["http://x:3456"],
        capabilities: ["feed", "send"],
      });
      const result = state.handleHello(hello, "10.0.0.1");
      expect(result.shouldPair).toBe(false);
    });

    it("shouldPair=false when already paired", () => {
      const zid = "00" + "0".repeat(30);
      const hello = makeHello({
        zid,
        node: "mba",
        oracle: "neo",
        locators: ["http://x:3456"],
        capabilities: ["pair"],
      });
      state.handleHello(hello, "10.0.0.1");
      state.markPaired(zid);

      // second hello from same peer
      const hello2 = makeHello({ zid, node: "mba", oracle: "neo", locators: ["http://x:3456"], capabilities: ["pair"] });
      const result = state.handleHello(hello2, "10.0.0.1");
      expect(result.shouldPair).toBe(false);
    });

    it("shouldPair=false when connection is pending", () => {
      const zid = "00" + "0".repeat(30);
      state.markPending(zid);
      const hello = makeHello({ zid, node: "mba", oracle: "neo", locators: ["http://x:3456"], capabilities: ["pair"] });
      const result = state.handleHello(hello, "10.0.0.1");
      expect(result.shouldPair).toBe(false);
    });

    it("exactly one side initiates for any pair of zids", () => {
      const zidA = generateZid();
      const zidB = generateZid();
      const stateA = new ScoutState(zidA);
      const stateB = new ScoutState(zidB);

      const helloFromB = makeHello({ zid: zidB, node: "b", oracle: "b", locators: ["http://b:3456"], capabilities: ["pair"] });
      const helloFromA = makeHello({ zid: zidA, node: "a", oracle: "a", locators: ["http://a:3456"], capabilities: ["pair"] });

      const aResult = stateA.handleHello(helloFromB, "10.0.0.2");
      const bResult = stateB.handleHello(helloFromA, "10.0.0.1");

      // exactly one should pair
      expect(aResult.shouldPair !== bResult.shouldPair).toBe(true);
    });
  });

  describe("peer management", () => {
    it("markPaired sets paired flag and clears pending", () => {
      const zid = "00" + "0".repeat(30);
      const hello = makeHello({ zid, node: "mba", oracle: "neo", locators: ["http://x:3456"] });
      state.handleHello(hello, "10.0.0.1");
      state.markPending(zid);
      state.markPaired(zid);

      expect(state.discoveredPeers.get(zid)!.paired).toBe(true);
      expect(state.pendingConnections.has(zid)).toBe(false);
    });

    it("findPeerByNode returns correct peer", () => {
      const hello = makeHello({ zid: generateZid(), node: "white", oracle: "mawjs", locators: ["http://x:3456"], oracles: ["mawjs-oracle"] });
      state.handleHello(hello, "10.0.0.1");
      expect(state.findPeerByNode("white")).toBeDefined();
      expect(state.findPeerByNode("nonexistent")).toBeUndefined();
    });

    it("findPeerByOracle matches partial oracle name", () => {
      const hello = makeHello({ zid: generateZid(), node: "white", oracle: "mawjs", locators: ["http://x:3456"], oracles: ["mawjs-oracle", "neo-oracle"] });
      state.handleHello(hello, "10.0.0.1");
      expect(state.findPeerByOracle("mawjs")).toBeDefined();
      expect(state.findPeerByOracle("neo")).toBeDefined();
      expect(state.findPeerByOracle("unknown")).toBeUndefined();
    });

    it("markExistingPeerPaired marks by node name", () => {
      const hello = makeHello({ zid: generateZid(), node: "mba", oracle: "neo", locators: ["http://x:3456"] });
      state.handleHello(hello, "10.0.0.1");
      state.markExistingPeerPaired("mba");
      const peer = state.findPeerByNode("mba");
      expect(peer!.paired).toBe(true);
    });
  });

  describe("pruneStale", () => {
    it("removes peers older than PEER_STALE_MS", () => {
      const zid = generateZid();
      const hello = makeHello({ zid, node: "old", oracle: "old", locators: ["http://x:3456"] });
      state.handleHello(hello, "10.0.0.1");

      // manually set lastSeen to past
      state.discoveredPeers.get(zid)!.lastSeen = Date.now() - PEER_STALE_MS - 1;

      const removed = state.pruneStale();
      expect(removed).toEqual(["old"]);
      expect(state.discoveredPeers.size).toBe(0);
    });

    it("keeps fresh peers", () => {
      const hello = makeHello({ zid: generateZid(), node: "fresh", oracle: "fresh", locators: ["http://x:3456"] });
      state.handleHello(hello, "10.0.0.1");

      const removed = state.pruneStale();
      expect(removed).toEqual([]);
      expect(state.discoveredPeers.size).toBe(1);
    });

    it("clears pending connections for pruned peers", () => {
      const zid = generateZid();
      const hello = makeHello({ zid, node: "stale", oracle: "stale", locators: ["http://x:3456"] });
      state.handleHello(hello, "10.0.0.1");
      state.markPending(zid);
      state.discoveredPeers.get(zid)!.lastSeen = Date.now() - PEER_STALE_MS - 1;

      state.pruneStale();
      expect(state.pendingConnections.has(zid)).toBe(false);
    });
  });
});
