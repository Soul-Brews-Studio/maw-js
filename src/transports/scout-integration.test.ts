import { describe, it, expect, afterEach } from "bun:test";
import { createSocket } from "dgram";
import {
  MULTICAST_ADDR,
  MULTICAST_PORT,
  makeScout,
  makeHello,
  generateZid,
  parseMessage,
} from "./scout-protocol";

describe("scout integration — real UDP", () => {
  const sockets: ReturnType<typeof createSocket>[] = [];

  afterEach(() => {
    for (const s of sockets) {
      try { s.dropMembership(MULTICAST_ADDR); } catch {}
      s.close();
    }
    sockets.length = 0;
  });

  it("scout message round-trips through multicast", async () => {
    const zid = generateZid();
    const received: any[] = [];

    const listener = createSocket({ type: "udp4", reuseAddr: true });
    sockets.push(listener);

    await new Promise<void>((resolve, reject) => {
      listener.bind(MULTICAST_PORT, () => {
        try {
          listener.addMembership(MULTICAST_ADDR);
          resolve();
        } catch (e) { reject(e); }
      });
      listener.on("error", reject);
    });

    listener.on("message", (buf) => {
      const msg = parseMessage(buf);
      if (msg && msg.type === "maw-scout") received.push(msg);
    });

    const sender = createSocket({ type: "udp4", reuseAddr: true });
    sockets.push(sender);
    const scout = makeScout(zid);
    const buf = Buffer.from(JSON.stringify(scout));
    sender.send(buf, MULTICAST_PORT, MULTICAST_ADDR);

    await new Promise((r) => setTimeout(r, 200));

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].type).toBe("maw-scout");
    expect(received[0].zid).toBe(zid);
  });

  it("hello unicast reply reaches scout sender", async () => {
    const scoutZid = generateZid();
    const helloZid = generateZid();
    const received: any[] = [];

    // Responder: listens on multicast, replies with Hello via unicast
    const responder = createSocket({ type: "udp4", reuseAddr: true });
    sockets.push(responder);

    await new Promise<void>((resolve, reject) => {
      responder.bind(MULTICAST_PORT, () => {
        try {
          responder.addMembership(MULTICAST_ADDR);
          resolve();
        } catch (e) { reject(e); }
      });
      responder.on("error", reject);
    });

    responder.on("message", (buf, rinfo) => {
      const msg = parseMessage(buf);
      if (msg && msg.type === "maw-scout" && msg.zid !== helloZid) {
        const hello = makeHello({
          zid: helloZid,
          node: "responder",
          oracle: "test",
          locators: ["http://responder:3456"],
          oracles: ["test-oracle"],
        });
        responder.send(
          Buffer.from(JSON.stringify(hello)),
          rinfo.port,
          rinfo.address,
        );
      }
    });

    // Sender: sends scout, collects hello responses
    const sender = createSocket({ type: "udp4", reuseAddr: true });
    sockets.push(sender);

    await new Promise<void>((resolve) => sender.bind(0, resolve));

    sender.on("message", (buf) => {
      const msg = parseMessage(buf);
      if (msg && msg.type === "maw-hello") received.push(msg);
    });

    const scout = makeScout(scoutZid);
    sender.send(Buffer.from(JSON.stringify(scout)), MULTICAST_PORT, MULTICAST_ADDR);

    await new Promise((r) => setTimeout(r, 500));

    expect(received.length).toBeGreaterThanOrEqual(1);
    const hello = received[0];
    expect(hello.type).toBe("maw-hello");
    expect(hello.zid).toBe(helloZid);
    expect(hello.node).toBe("responder");
    expect(hello.locators).toEqual(["http://responder:3456"]);
  });

  it("legacy maw-announce is parseable alongside scout messages", () => {
    const announce = { type: "maw-announce", node: "legacy-node", port: 3456, oracles: ["old-oracle"], ts: Date.now() };
    const scout = makeScout(generateZid());
    const hello = makeHello({ zid: generateZid(), node: "n", oracle: "o", locators: ["http://x:3456"] });

    const msgs = [announce, scout, hello].map((m) =>
      parseMessage(Buffer.from(JSON.stringify(m)))
    );

    expect(msgs[0]!.type).toBe("maw-announce");
    expect(msgs[1]!.type).toBe("maw-scout");
    expect(msgs[2]!.type).toBe("maw-hello");
  });

  it("GreaterZid ensures exactly one initiator in simulated 2-node handshake", () => {
    const zidA = generateZid();
    const zidB = generateZid();

    // Simulate both sides receiving each other's Hello
    const { ScoutState } = require("./scout-state");
    const stateA = new ScoutState(zidA);
    const stateB = new ScoutState(zidB);

    const helloA = makeHello({ zid: zidA, node: "nodeA", oracle: "a", locators: ["http://a:3456"], capabilities: ["pair"] });
    const helloB = makeHello({ zid: zidB, node: "nodeB", oracle: "b", locators: ["http://b:3456"], capabilities: ["pair"] });

    const resultA = stateA.handleHello(helloB, "10.0.0.2");
    const resultB = stateB.handleHello(helloA, "10.0.0.1");

    // Exactly one should pair
    const pairCount = [resultA.shouldPair, resultB.shouldPair].filter(Boolean).length;
    expect(pairCount).toBe(1);

    // The one with greater ZID is the initiator
    if (zidA > zidB) {
      expect(resultA.shouldPair).toBe(true);
      expect(resultB.shouldPair).toBe(false);
    } else {
      expect(resultA.shouldPair).toBe(false);
      expect(resultB.shouldPair).toBe(true);
    }
  });
});
