import { describe, it, expect } from "bun:test";
import {
  generateZid,
  greaterZid,
  makeScout,
  makeHello,
  parseMessage,
  SCOUT_VERSION,
  MULTICAST_ADDR,
  MULTICAST_PORT,
} from "./scout-protocol";

describe("scout-protocol", () => {
  describe("generateZid", () => {
    it("returns 32-char hex string (16 bytes)", () => {
      const zid = generateZid();
      expect(zid).toHaveLength(32);
      expect(zid).toMatch(/^[0-9a-f]{32}$/);
    });

    it("generates unique IDs", () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateZid()));
      expect(ids.size).toBe(100);
    });
  });

  describe("greaterZid", () => {
    it("returns true when a > b", () => {
      expect(greaterZid("ff", "00")).toBe(true);
      expect(greaterZid("b", "a")).toBe(true);
    });

    it("returns false when a < b", () => {
      expect(greaterZid("00", "ff")).toBe(false);
      expect(greaterZid("a", "b")).toBe(false);
    });

    it("returns false when equal", () => {
      expect(greaterZid("abc", "abc")).toBe(false);
    });

    it("exactly one side initiates for any pair", () => {
      const a = generateZid();
      const b = generateZid();
      // exactly one of these is true (unless equal, which is astronomically unlikely)
      const aInitiates = greaterZid(a, b);
      const bInitiates = greaterZid(b, a);
      expect(aInitiates !== bInitiates).toBe(true);
    });
  });

  describe("makeScout", () => {
    it("creates valid scout message", () => {
      const zid = generateZid();
      const msg = makeScout(zid);
      expect(msg.type).toBe("maw-scout");
      expect(msg.version).toBe(SCOUT_VERSION);
      expect(msg.zid).toBe(zid);
      expect(msg.whatAmI).toBe("oracle");
      expect(msg.ts).toBeGreaterThan(0);
    });

    it("accepts custom whatAmI", () => {
      const msg = makeScout(generateZid(), "hub");
      expect(msg.whatAmI).toBe("hub");
    });
  });

  describe("makeHello", () => {
    it("creates valid hello message", () => {
      const zid = generateZid();
      const msg = makeHello({
        zid,
        node: "white",
        oracle: "neo",
        locators: ["http://192.168.1.10:3456"],
        oracles: ["neo-oracle", "mawjs-oracle"],
      });
      expect(msg.type).toBe("maw-hello");
      expect(msg.version).toBe(SCOUT_VERSION);
      expect(msg.zid).toBe(zid);
      expect(msg.node).toBe("white");
      expect(msg.oracle).toBe("neo");
      expect(msg.locators).toEqual(["http://192.168.1.10:3456"]);
      expect(msg.capabilities).toEqual(["pair", "feed", "send"]);
      expect(msg.oracles).toEqual(["neo-oracle", "mawjs-oracle"]);
    });

    it("uses defaults for optional fields", () => {
      const msg = makeHello({
        zid: generateZid(),
        node: "mba",
        oracle: "mawjs",
        locators: ["http://mba:3456"],
      });
      expect(msg.capabilities).toEqual(["pair", "feed", "send"]);
      expect(msg.oracles).toEqual([]);
      expect(msg.whatAmI).toBe("oracle");
    });
  });

  describe("parseMessage", () => {
    it("parses scout message", () => {
      const scout = makeScout(generateZid());
      const buf = Buffer.from(JSON.stringify(scout));
      const parsed = parseMessage(buf);
      expect(parsed).not.toBeNull();
      expect(parsed!.type).toBe("maw-scout");
    });

    it("parses hello message", () => {
      const hello = makeHello({
        zid: generateZid(),
        node: "test",
        oracle: "test",
        locators: ["http://test:3456"],
      });
      const buf = Buffer.from(JSON.stringify(hello));
      const parsed = parseMessage(buf);
      expect(parsed).not.toBeNull();
      expect(parsed!.type).toBe("maw-hello");
    });

    it("parses legacy announce message", () => {
      const announce = { type: "maw-announce", node: "old", port: 3456, oracles: [], ts: Date.now() };
      const buf = Buffer.from(JSON.stringify(announce));
      const parsed = parseMessage(buf);
      expect(parsed).not.toBeNull();
      expect(parsed!.type).toBe("maw-announce");
    });

    it("returns null for unknown message types", () => {
      const buf = Buffer.from(JSON.stringify({ type: "unknown" }));
      expect(parseMessage(buf)).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      expect(parseMessage(Buffer.from("not json"))).toBeNull();
    });

    it("returns null for empty buffer", () => {
      expect(parseMessage(Buffer.from(""))).toBeNull();
    });
  });

  describe("constants", () => {
    it("multicast address matches zenoh default", () => {
      expect(MULTICAST_ADDR).toBe("224.0.0.224");
    });

    it("port is 31746", () => {
      expect(MULTICAST_PORT).toBe(31746);
    });
  });
});
