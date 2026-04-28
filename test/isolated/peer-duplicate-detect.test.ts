/**
 * peer-duplicate-detect.test.ts — #804 Step 3.
 *
 * Doctor + boot-warn collision detection for duplicate `<oracle>:<node>`
 * peers in the local cache. Per ADR docs/federation/0001-peer-identity.md
 * ("Multi-oracle-per-node is a naming convention, not a protocol concern:
 * oracle names must be unique within a node. `maw doctor` enforces; `maw
 * serve` warns at boot if it detects a duplicate `<oracle>:<node>` claim
 * across `peers.json`.")
 *
 * Test coverage:
 *   1. Two peers with same oracle:node → doctor flags collision
 *   2. Two peers with different oracle:node → doctor passes
 *   3. Local (oracle, node) collides with a cached peer → boot-warn fires
 *   4. Empty / missing identity (legacy peer) → skipped, no false positive
 *   5. Three-way collision lists all three
 *   6. boot-warn logger receives one msg + one hint per duplicate
 *
 * Isolated because the doctor / store paths read PEERS_FILE; we sandbox
 * that per-test under a tmp dir.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  findDuplicateIdentities,
  formatDuplicate,
  warnDuplicatesAtBoot,
} from "../../src/commands/plugins/peers/duplicate-detect";
import type { Peer } from "../../src/commands/plugins/peers/store";

// ─── Helpers ────────────────────────────────────────────────────────────────

function peer(opts: Partial<Peer> & { url: string; identity?: Peer["identity"] }): Peer {
  return {
    url: opts.url,
    node: opts.node ?? null,
    addedAt: opts.addedAt ?? new Date().toISOString(),
    lastSeen: opts.lastSeen ?? null,
    ...(opts.identity ? { identity: opts.identity } : {}),
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maw-dup-detect-804-"));
  process.env.PEERS_FILE = join(dir, "peers.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PEERS_FILE;
});

// ════════════════════════════════════════════════════════════════════════════
// findDuplicateIdentities — pure logic
// ════════════════════════════════════════════════════════════════════════════

describe("findDuplicateIdentities — peer-vs-peer", () => {
  test("two peers with same oracle:node → 1 duplicate listing both", () => {
    const peers = {
      whiteA: peer({ url: "http://a:3456", identity: { oracle: "mawjs", node: "white" } }),
      whiteB: peer({ url: "http://b:3456", identity: { oracle: "mawjs", node: "white" } }),
    };
    const dups = findDuplicateIdentities(peers);
    expect(dups).toHaveLength(1);
    expect(dups[0].key).toBe("mawjs:white");
    expect(dups[0].claimants.map(c => c.alias).sort()).toEqual(["whiteA", "whiteB"]);
  });

  test("two peers with different oracle:node → no duplicates", () => {
    const peers = {
      white: peer({ url: "http://a:3456", identity: { oracle: "mawjs", node: "white" } }),
      mba: peer({ url: "http://b:3456", identity: { oracle: "mawjs", node: "mba" } }),
    };
    expect(findDuplicateIdentities(peers)).toEqual([]);
  });

  test("same node but DIFFERENT oracle → no duplicate (multi-oracle-per-node ok)", () => {
    const peers = {
      mawjsM5: peer({ url: "http://x:3456", identity: { oracle: "mawjs", node: "m5" } }),
      neoM5: peer({ url: "http://y:3456", identity: { oracle: "neo", node: "m5" } }),
    };
    expect(findDuplicateIdentities(peers)).toEqual([]);
  });

  test("three-way collision → all three claimants reported under one key", () => {
    const peers = {
      a: peer({ url: "http://a:3456", identity: { oracle: "mawjs", node: "white" } }),
      b: peer({ url: "http://b:3456", identity: { oracle: "mawjs", node: "white" } }),
      c: peer({ url: "http://c:3456", identity: { oracle: "mawjs", node: "white" } }),
    };
    const dups = findDuplicateIdentities(peers);
    expect(dups).toHaveLength(1);
    expect(dups[0].claimants).toHaveLength(3);
  });

  test("legacy peer (no identity) is skipped — no false positive", () => {
    const peers = {
      legacy1: peer({ url: "http://l1:3456" }),
      legacy2: peer({ url: "http://l2:3456" }),
      pinned: peer({ url: "http://p:3456", identity: { oracle: "mawjs", node: "white" } }),
    };
    expect(findDuplicateIdentities(peers)).toEqual([]);
  });

  test("empty cache → no duplicates", () => {
    expect(findDuplicateIdentities({})).toEqual([]);
  });
});

describe("findDuplicateIdentities — local-vs-peer", () => {
  test("local collides with a cached peer → duplicate includes <local>", () => {
    const peers = {
      mePeer: peer({ url: "http://other:3456", identity: { oracle: "mawjs", node: "white" } }),
    };
    const dups = findDuplicateIdentities(peers, { oracle: "mawjs", node: "white" });
    expect(dups).toHaveLength(1);
    expect(dups[0].key).toBe("mawjs:white");
    const aliases = dups[0].claimants.map(c => c.alias).sort();
    expect(aliases).toContain("<local>");
    expect(aliases).toContain("mePeer");
  });

  test("local does NOT collide → no duplicate", () => {
    const peers = {
      mba: peer({ url: "http://m:3456", identity: { oracle: "mawjs", node: "mba" } }),
    };
    const dups = findDuplicateIdentities(peers, { oracle: "mawjs", node: "white" });
    expect(dups).toEqual([]);
  });

  test("local with no peers + no local → no duplicate", () => {
    expect(findDuplicateIdentities({})).toEqual([]);
  });
});

describe("formatDuplicate — output shape", () => {
  test("includes the key and all claimants with urls", () => {
    const line = formatDuplicate({
      key: "mawjs:white",
      claimants: [
        { alias: "whiteA", url: "http://a:3456" },
        { alias: "whiteB", url: "http://b:3456" },
      ],
    });
    expect(line).toContain("mawjs:white");
    expect(line).toContain("whiteA");
    expect(line).toContain("http://a:3456");
    expect(line).toContain("whiteB");
    expect(line).toContain("http://b:3456");
  });

  test("local claimant has no url printed", () => {
    const line = formatDuplicate({
      key: "mawjs:white",
      claimants: [{ alias: "<local>" }, { alias: "peerA", url: "http://a" }],
    });
    expect(line).toContain("<local>");
    expect(line).not.toContain("<local> (");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// warnDuplicatesAtBoot — boot-warn hook
// ════════════════════════════════════════════════════════════════════════════

describe("warnDuplicatesAtBoot", () => {
  test("local collides with cached peer → fires 2 log lines (warn + hint)", () => {
    const logs: string[] = [];
    const dups = warnDuplicatesAtBoot({
      peers: {
        mePeer: peer({ url: "http://x:3456", identity: { oracle: "mawjs", node: "white" } }),
      },
      local: { oracle: "mawjs", node: "white" },
      log: (m) => logs.push(m),
    });
    expect(dups).toHaveLength(1);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("duplicate <oracle>:<node>");
    expect(logs[0]).toContain("mawjs:white");
    expect(logs[1]).toContain("maw peers remove");
  });

  test("no collisions → no log output, returns empty array", () => {
    const logs: string[] = [];
    const dups = warnDuplicatesAtBoot({
      peers: {
        mba: peer({ url: "http://m:3456", identity: { oracle: "mawjs", node: "mba" } }),
      },
      local: { oracle: "mawjs", node: "white" },
      log: (m) => logs.push(m),
    });
    expect(dups).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("legacy peer set with no identities → no log output", () => {
    const logs: string[] = [];
    const dups = warnDuplicatesAtBoot({
      peers: {
        legacy: peer({ url: "http://l:3456" }),
      },
      local: { oracle: "mawjs", node: "white" },
      log: (m) => logs.push(m),
    });
    expect(dups).toEqual([]);
    expect(logs).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// cmdDoctor — peers:duplicates check end-to-end
// ════════════════════════════════════════════════════════════════════════════

/** Stub a peers.json on disk. */
function writePeers(peers: Record<string, Peer>) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    process.env.PEERS_FILE!,
    JSON.stringify({ version: 1, peers }, null, 2),
  );
}

describe("cmdDoctor peers:duplicates", () => {
  test("two peers with same oracle:node → doctor flags collision (ok=false)", async () => {
    // Synthetic peer node names — chosen so the *peer-vs-peer* collision is
    // the one the test asserts on, regardless of whatever the developer's
    // local maw.config.json node happens to be.
    writePeers({
      twinA: peer({ url: "http://a:3456", identity: { oracle: "mawjs", node: "synth-twin" } }),
      twinB: peer({ url: "http://b:3456", identity: { oracle: "mawjs", node: "synth-twin" } }),
    });

    const { cmdDoctor } = await import("../../src/commands/plugins/doctor/impl");
    const origLog = console.log;
    console.log = () => {};
    try {
      const out = await cmdDoctor(["peers"]);
      const dup = out.checks.find(c => c.name === "peers:duplicates")!;
      expect(dup).toBeDefined();
      expect(dup.ok).toBe(false);
      expect(dup.message).toContain("mawjs:synth-twin");
      expect(dup.message).toContain("twinA");
      expect(dup.message).toContain("twinB");
    } finally {
      console.log = origLog;
    }
  });

  test("two peers with different oracle:node → doctor passes", async () => {
    // Use node names that won't accidentally match the local maw.config.json
    // (which on dev boxes might be "white" / "mba" / etc). Doctor reads
    // loadConfig() for the local identity; sandboxing the peers file is not
    // enough — we also have to pick clearly-synthetic peer node names.
    writePeers({
      synth1: peer({ url: "http://a:3456", identity: { oracle: "mawjs", node: "synth-node-aaa" } }),
      synth2: peer({ url: "http://b:3456", identity: { oracle: "mawjs", node: "synth-node-bbb" } }),
    });

    const { cmdDoctor } = await import("../../src/commands/plugins/doctor/impl");
    const origLog = console.log;
    console.log = () => {};
    try {
      const out = await cmdDoctor(["peers"]);
      const dup = out.checks.find(c => c.name === "peers:duplicates")!;
      expect(dup).toBeDefined();
      expect(dup.ok).toBe(true);
      expect(dup.message).toContain("no <oracle>:<node> collisions");
    } finally {
      console.log = origLog;
    }
  });

  test("legacy peer (no identity) → skipped, no false positive", async () => {
    writePeers({
      legacy1: peer({ url: "http://l1:3456" }),
      legacy2: peer({ url: "http://l2:3456" }),
    });

    const { cmdDoctor } = await import("../../src/commands/plugins/doctor/impl");
    const origLog = console.log;
    console.log = () => {};
    try {
      const out = await cmdDoctor(["peers"]);
      const dup = out.checks.find(c => c.name === "peers:duplicates")!;
      expect(dup.ok).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  test("empty peer cache → ok=true, 'no peers cached'", async () => {
    writePeers({});

    const { cmdDoctor } = await import("../../src/commands/plugins/doctor/impl");
    const origLog = console.log;
    console.log = () => {};
    try {
      const out = await cmdDoctor(["peers"]);
      const dup = out.checks.find(c => c.name === "peers:duplicates")!;
      expect(dup.ok).toBe(true);
      expect(dup.message).toContain("no peers cached");
    } finally {
      console.log = origLog;
    }
  });
});
