import { describe, expect, test, beforeEach } from "bun:test";
import { prunePinAttempts } from "../src/api/config";
import { _inject, _resetStore, _storeSize, lookup, prunePairCodes, type PairEntry } from "../src/lib/pair-codes";
import { _injectResult, _resetResults, _resultSize, prunePairResults } from "../src/api/pair";
import { ScoutTransport } from "../src/transports/scout";
import { ScoutState } from "../src/transports/scout-state";
import { makeHello } from "../src/transports/scout-protocol";
import { startServeMemoryMaintenance } from "../src/vendor-plugins/serve-maintenance";

describe("federation map pruning", () => {
  beforeEach(() => {
    _resetStore();
    _resetResults();
  });

  test("prunePinAttempts evicts expired attempts and caps live cardinality", () => {
    const attempts = new Map<string, { count: number; resetAt: number }>([
      ["expired", { count: 5, resetAt: 900 }],
      ["live-old", { count: 1, resetAt: 2_000 }],
      ["live-new", { count: 1, resetAt: 3_000 }],
    ]);

    expect(prunePinAttempts(attempts, 1_000, 1)).toBe(2);
    expect([...attempts.keys()]).toEqual(["live-new"]);
  });

  test("prunePairCodes evicts expired and consumed codes while keeping live codes", () => {
    const entry = (code: string, expiresAt: number, consumed = false): PairEntry => ({
      code,
      expiresAt,
      consumed,
      createdAt: 1,
    });
    _inject(entry("ABCDEF", 900));
    _inject(entry("GHJKLM", 2_000, true));
    _inject(entry("NPQRST", 9_999_999_999_999));

    expect(prunePairCodes(1_000)).toBe(2);
    expect(_storeSize()).toBe(1);
    expect(lookup("NPQRST").ok).toBe(true);
    expect(lookup("ABCDEF")).toEqual({ ok: false, reason: "not_found" });
  });

  test("prunePairResults evicts stale status results and keeps fresh polling results", () => {
    _injectResult("ABCDEF", { consumedAt: 1_000, remoteNode: "old", remoteUrl: "http://old" });
    _injectResult("GHJKLM", { consumedAt: 4_500, remoteNode: "live", remoteUrl: "http://live" });

    expect(prunePairResults(5_000, 2_000)).toBe(1);
    expect(_resultSize()).toBe(1);
  });

  test("ScoutTransport stale sweep prunes pair failures for gone peers only", () => {
    const transport: any = new ScoutTransport({ node: "local", port: 3456, autoPair: true });
    transport.state = new ScoutState("zz-local");
    transport.state.handleHello(makeHello({
      zid: "z-live",
      node: "live-node",
      oracle: "live-oracle",
      locators: ["http://live:3456"],
      capabilities: ["pair"],
      oracles: ["live-oracle"],
    }), "10.0.0.2");
    transport.state.handleHello(makeHello({
      zid: "z-old",
      node: "old-node",
      oracle: "old-oracle",
      locators: ["http://old:3456"],
      capabilities: ["pair"],
      oracles: ["old-oracle"],
    }), "10.0.0.3");
    transport.state.discoveredPeers.get("z-old")!.lastSeen = Date.now() - 31_000;
    transport.pairFailures.set("live-node", { count: 1, cooldownUntil: Date.now() + 10_000, lastError: "live", cooldownLogged: false });
    transport.pairFailures.set("old-node", { count: 1, cooldownUntil: Date.now() + 10_000, lastError: "old", cooldownLogged: false });

    transport.pruneStale();

    expect(transport.pairFailures.has("live-node")).toBe(true);
    expect(transport.pairFailures.has("old-node")).toBe(false);
  });

  test("serve memory maintenance reuses the existing timer for federation pruners", () => {
    const calls: string[] = [];
    let handler: (() => void) | null = null;
    startServeMemoryMaintenance({
      messageQueue: { prune: () => calls.push("message") },
      requestReplyStore: { prune: () => calls.push("request") },
      agentStatusStore: { prune: () => calls.push("agent") },
      prunePinAttempts: () => calls.push("pin") ,
      prunePairCodes: () => calls.push("codes"),
      prunePairResults: () => calls.push("results"),
      setInterval: (fn) => { handler = fn; return { unref: () => calls.push("unref") }; },
    });

    handler?.();

    expect(calls).toEqual(["unref", "message", "request", "agent", "pin", "codes", "results"]);
  });
});
