import { describe, test, expect } from "bun:test";
import { resolveBindHost, type BindConfig } from "../src/core/bind-host";

const EMPTY: BindConfig = {};
const EMPTY_ENV = {};
const EMPTY_STORE = () => ({ peers: {} });

describe("resolveBindHost (#616)", () => {
  test("loopback when nothing is configured", () => {
    const r = resolveBindHost(EMPTY, EMPTY_ENV, EMPTY_STORE);
    expect(r.hostname).toBe("127.0.0.1");
    expect(r.reason).toBe(null);
  });

  test("trigger 1: config.peers populated", () => {
    const r = resolveBindHost({ peers: ["http://host:7777"] }, EMPTY_ENV, EMPTY_STORE);
    expect(r.hostname).toBe("0.0.0.0");
    expect(r.reason).toBe("config.peers");
  });

  test("trigger 2: config.namedPeers populated", () => {
    const r = resolveBindHost({ namedPeers: [{ alias: "a", url: "http://a:7777" }] }, EMPTY_ENV, EMPTY_STORE);
    expect(r.hostname).toBe("0.0.0.0");
    expect(r.reason).toBe("config.namedPeers");
  });

  test("trigger 3: MAW_HOST=0.0.0.0 env opt-in", () => {
    const r = resolveBindHost(EMPTY, { MAW_HOST: "0.0.0.0" }, EMPTY_STORE);
    expect(r.hostname).toBe("0.0.0.0");
    expect(r.reason).toBe("MAW_HOST");
  });

  test("trigger 4: peers.json non-empty", () => {
    const store = () => ({ peers: { white: { url: "http://white:7777", node: "white", addedAt: "", lastSeen: null } as unknown } });
    const r = resolveBindHost(EMPTY, EMPTY_ENV, store);
    expect(r.hostname).toBe("0.0.0.0");
    expect(r.reason).toBe("peers.json");
  });

  test("empty peers.json stays on loopback", () => {
    const r = resolveBindHost(EMPTY, EMPTY_ENV, () => ({ peers: {} }));
    expect(r.hostname).toBe("127.0.0.1");
    expect(r.reason).toBe(null);
  });

  test("MAW_HOST set to a non-0.0.0.0 value (e.g. node name 'white') does not trigger", () => {
    // MAW_HOST is also used elsewhere as a node-name identifier; only literal
    // "0.0.0.0" should flip the bind — "white" / "local" / etc. must not.
    const r = resolveBindHost(EMPTY, { MAW_HOST: "white" }, EMPTY_STORE);
    expect(r.hostname).toBe("127.0.0.1");
    expect(r.reason).toBe(null);
  });

  test("empty peers array does not trigger", () => {
    const r = resolveBindHost({ peers: [], namedPeers: [] }, EMPTY_ENV, EMPTY_STORE);
    expect(r.hostname).toBe("127.0.0.1");
    expect(r.reason).toBe(null);
  });

  test("peers-store reader that throws falls through to loopback", () => {
    const thrower = () => { throw new Error("disk read failed"); };
    const r = resolveBindHost(EMPTY, EMPTY_ENV, thrower);
    expect(r.hostname).toBe("127.0.0.1");
    expect(r.reason).toBe(null);
  });

  test("config.peers takes priority over MAW_HOST (reason attribution)", () => {
    const r = resolveBindHost({ peers: ["http://x:7777"] }, { MAW_HOST: "0.0.0.0" }, EMPTY_STORE);
    expect(r.hostname).toBe("0.0.0.0");
    expect(r.reason).toBe("config.peers");
  });
});
