import { describe, expect, test } from "bun:test";
import {
  findDuplicateIdentities,
  formatDuplicate,
  warnDuplicatesAtBoot,
} from "../../src/vendor/mpr-plugins/doctor/internal/duplicate-detect";
import type { Peer } from "../../src/vendor/mpr-plugins/doctor/internal/peers-store";

function peer(url: string, oracle?: string, node?: string): Peer {
  return {
    url,
    node: node ?? null,
    addedAt: "2026-05-18T00:00:00.000Z",
    lastSeen: null,
    identity: oracle && node ? { oracle, node } : undefined,
  };
}

describe("doctor duplicate identity detection coverage", () => {
  test("includes local identity, skips legacy/incomplete peers, and formats URL-less claimants", () => {
    const peers: Record<string, Peer> = {
      localCopy: peer("http://copy", "mawjs", "m5"),
      otherA: peer("http://a", "pulse", "white"),
      otherB: peer("http://b", "pulse", "white"),
      legacy: peer("http://legacy"),
      missingOracle: { ...peer("http://missing"), identity: { oracle: "", node: "node" } },
    };

    const dups = findDuplicateIdentities(peers, { oracle: "mawjs", node: "m5" });

    expect(dups.map(d => d.key)).toEqual(["mawjs:m5", "pulse:white"]);
    expect(dups[0]?.claimants).toEqual([
      { alias: "<local>" },
      { alias: "localCopy", url: "http://copy" },
    ]);
    expect(formatDuplicate(dups[0]!)).toBe('duplicate <oracle>:<node> claim "mawjs:m5" — <local>, localCopy (http://copy)');
  });

  test("warnDuplicatesAtBoot defaults to console.warn and returns an empty list when clean", () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg?: unknown) => warnings.push(String(msg));
    try {
      expect(warnDuplicatesAtBoot({ peers: { solo: peer("http://solo", "solo", "node") } })).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toEqual([]);
  });

  test("warnDuplicatesAtBoot logs both warning lines for collisions", () => {
    const logs: string[] = [];
    const dups = warnDuplicatesAtBoot({
      peers: {
        a: peer("http://a", "pulse", "white"),
        b: peer("http://b", "pulse", "white"),
      },
      log: (msg) => logs.push(msg),
    });

    expect(dups).toHaveLength(1);
    expect(logs[0]).toContain("duplicate <oracle>:<node> claim");
    expect(logs[1]).toContain("investigate with `maw peers list`");
  });
});
