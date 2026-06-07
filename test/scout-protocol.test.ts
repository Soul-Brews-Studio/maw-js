import { describe, expect, test } from "bun:test";
import {
  generateZid,
  greaterZid,
  makeHello,
  makeScout,
  parseMessage,
  MULTICAST_ADDR,
  MULTICAST_PORT,
  SCOUT_VERSION,
} from "../src/transports/scout-protocol";

describe("scout-protocol pure helpers", () => {
  test("generateZid returns unique 16-byte hex ids", () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateZid()));
    expect(ids.size).toBe(20);
    for (const zid of ids) expect(zid).toMatch(/^[0-9a-f]{32}$/);
  });

  test("greaterZid elects exactly one initiator", () => {
    expect(greaterZid("ff", "00")).toBe(true);
    expect(greaterZid("00", "ff")).toBe(false);
    expect(greaterZid("abc", "abc")).toBe(false);
    const a = generateZid();
    const b = generateZid();
    expect(greaterZid(a, b) !== greaterZid(b, a)).toBe(true);
  });

  test("makeScout and makeHello produce versioned protocol messages", () => {
    const zid = generateZid();
    const scout = makeScout(zid, "hub");
    expect(scout).toMatchObject({ type: "maw-scout", version: SCOUT_VERSION, zid, whatAmI: "hub" });
    expect(scout.ts).toBeGreaterThan(0);

    const hello = makeHello({ zid, node: "m5", oracle: "mawjs", locators: ["http://m5:3456"] });
    expect(hello).toMatchObject({
      type: "maw-hello",
      version: SCOUT_VERSION,
      zid,
      node: "m5",
      oracle: "mawjs",
      capabilities: ["pair", "feed", "send"],
      oracles: [],
      whatAmI: "oracle",
    });
  });

  test("makeHello preserves explicit capabilities, oracles, and whatAmI", () => {
    const hello = makeHello({
      zid: "01",
      node: "bridge-node",
      oracle: "bridge",
      locators: ["ws://bridge:10000"],
      capabilities: ["pair"],
      oracles: ["mawjs-oracle"],
      whatAmI: "bridge",
    });
    expect(hello.capabilities).toEqual(["pair"]);
    expect(hello.oracles).toEqual(["mawjs-oracle"]);
    expect(hello.whatAmI).toBe("bridge");
  });

  test("parseMessage accepts scout, hello, and legacy announce messages", () => {
    const scout = makeScout(generateZid());
    const hello = makeHello({ zid: generateZid(), node: "n", oracle: "o", locators: [] });
    const announce = { type: "maw-announce", node: "old", port: 3456, oracles: [], ts: Date.now() };
    expect(parseMessage(Buffer.from(JSON.stringify(scout)))?.type).toBe("maw-scout");
    expect(parseMessage(Buffer.from(JSON.stringify(hello)))?.type).toBe("maw-hello");
    expect(parseMessage(Buffer.from(JSON.stringify(announce)))?.type).toBe("maw-announce");
  });

  test("parseMessage rejects invalid JSON and unknown message types", () => {
    expect(parseMessage(Buffer.from("not json"))).toBeNull();
    expect(parseMessage(Buffer.from(""))).toBeNull();
    expect(parseMessage(Buffer.from(JSON.stringify({ type: "unknown" })))).toBeNull();
  });

  test("scout multicast constants stay stable", () => {
    expect(MULTICAST_ADDR).toBe("224.0.0.224");
    expect(MULTICAST_PORT).toBe(31746);
  });
});
