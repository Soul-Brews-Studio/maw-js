import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const originalPeersFile = process.env.PEERS_FILE;
const originalTtl = process.env.MAW_PEER_STALE_TTL_MS;

afterEach(() => {
  if (originalPeersFile === undefined) delete process.env.PEERS_FILE;
  else process.env.PEERS_FILE = originalPeersFile;
  if (originalTtl === undefined) delete process.env.MAW_PEER_STALE_TTL_MS;
  else process.env.MAW_PEER_STALE_TTL_MS = originalTtl;
});

describe("coverage-100b vendor-b store and queue gaps", () => {
  test("cross-team queue default handle returns the empty v1 response", async () => {
    const mod = await import("../../src/vendor/mpr-plugins/cross-team-queue/src/index.ts?coverage-100b-queue");

    const response = await mod.handle();

    expect(response).toEqual({
      items: [],
      stats: {
        totalItems: 0,
        byRecipient: {},
        byType: {},
        oldestAgeHours: null,
        newestAgeHours: null,
      },
      errors: [],
      schemaVersion: 1,
    });
  });

  test("peers store copies tolerate unreadable live path and stale tmp cleanup errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-coverage-100b-store-"));
    const liveDir = join(root, "peers-as-dir.json");
    mkdirSync(liveDir);
    process.env.PEERS_FILE = liveDir;

    const peers = await import("../../src/vendor/mpr-plugins/peers/store.ts?coverage-100b-peers-store");
    const doctor = await import("../../src/vendor/mpr-plugins/doctor/internal/peers-store.ts?coverage-100b-doctor-store");
    const pair = await import("../../src/vendor/mpr-plugins/pair/internal/store.ts?coverage-100b-pair-store");

    expect(peers.loadPeers()).toEqual({ version: 1, peers: {} });
    expect(doctor.loadPeers()).toEqual({ version: 1, peers: {} });
    expect(pair.loadPeers()).toEqual({ version: 1, peers: {} });

    const tmpPath = `${liveDir}.tmp`;
    writeFileSync(tmpPath, "leftover");
    peers.clearStaleTmp();
    expect(existsSync(tmpPath)).toBe(false);
  });

  test("stale TTL and ages cover fallback parsing branches in both store copies", async () => {
    const peers = await import("../../src/vendor/mpr-plugins/peers/store.ts?coverage-100b-peers-store-ttl");
    const doctor = await import("../../src/vendor/mpr-plugins/doctor/internal/peers-store.ts?coverage-100b-doctor-store-ttl");

    process.env.MAW_PEER_STALE_TTL_MS = "bad";
    expect(peers.getStaleTtlMs()).toBe(peers.DEFAULT_STALE_TTL_MS);
    expect(doctor.getStaleTtlMs()).toBe(doctor.DEFAULT_STALE_TTL_MS);

    process.env.MAW_PEER_STALE_TTL_MS = "2500";
    expect(peers.getStaleTtlMs()).toBe(2500);
    expect(doctor.getStaleTtlMs()).toBe(2500);

    expect(peers.staleAgeMs({ url: "u", node: null, addedAt: "not-a-date", lastSeen: null } as any, 10)).toBeNull();
    expect(doctor.staleAgeMs({ url: "u", node: null, addedAt: "not-a-date", lastSeen: null } as any, 10)).toBeNull();
    expect(peers.isStale({ url: "u", node: null, addedAt: "", lastSeen: null } as any, 10, 10)).toBe(true);
    expect(doctor.isStale({ url: "u", node: null, addedAt: "", lastSeen: null } as any, 10, 10)).toBe(true);
  });
});
