/** Isolated coverage for src/vendor/mpr-plugins/doctor/internal/stale-peers.ts. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-05-18T00:00:00.000Z");

const originalPeersFile = process.env.PEERS_FILE;
const originalTtl = process.env.MAW_PEER_STALE_TTL_MS;
const originalTestMode = process.env.MAW_TEST_MODE;
const originalLog = console.log;
const originalStdoutWrite = process.stdout.write;
const originalBunSleep = Bun.sleep;
const originalDateNow = Date.now;

let tempDir = "";
let logs: string[] = [];

const { findStalePeers, checkStalePeers, cmdFixStalePeers } = await import(
  "../../src/vendor/mpr-plugins/doctor/internal/stale-peers.ts?stale-peers-coverage"
);

function isoDaysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

function writePeers(peers: Record<string, any>) {
  writeFileSync(join(tempDir, "peers.json"), JSON.stringify({ version: 1, peers }, null, 2) + "\n", "utf-8");
}

function readPeers(): Record<string, any> {
  return JSON.parse(readFileSync(join(tempDir, "peers.json"), "utf-8")).peers;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "maw-stale-peers-"));
  process.env.PEERS_FILE = join(tempDir, "peers.json");
  delete process.env.MAW_PEER_STALE_TTL_MS;
  delete process.env.MAW_TEST_MODE;
  logs = [];
  Date.now = () => NOW;
  console.log = (line?: unknown) => {
    logs.push(String(line ?? ""));
  };
});

afterEach(() => {
  console.log = originalLog;
  process.stdout.write = originalStdoutWrite;
  Bun.sleep = originalBunSleep;
  Date.now = originalDateNow;
  if (originalPeersFile === undefined) delete process.env.PEERS_FILE;
  else process.env.PEERS_FILE = originalPeersFile;
  if (originalTtl === undefined) delete process.env.MAW_PEER_STALE_TTL_MS;
  else process.env.MAW_PEER_STALE_TTL_MS = originalTtl;
  if (originalTestMode === undefined) delete process.env.MAW_TEST_MODE;
  else process.env.MAW_TEST_MODE = originalTestMode;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("findStalePeers", () => {
  test("enumerates only stale peers with stable alias ordering and age fallback", () => {
    writePeers({
      zebra: { url: "http://zebra.local", node: null, addedAt: isoDaysAgo(40), lastSeen: isoDaysAgo(10) },
      fresh: { url: "http://fresh.local", node: null, addedAt: isoDaysAgo(20), lastSeen: isoDaysAgo(1) },
      alpha: { url: "http://alpha.local", node: null, addedAt: isoDaysAgo(8), lastSeen: null },
      exactTtl: { url: "http://exact.local", node: null, addedAt: isoDaysAgo(30), lastSeen: isoDaysAgo(7) },
      brokenClock: { url: "http://broken.local", node: null, addedAt: "not-a-date", lastSeen: null },
    });

    expect(findStalePeers(NOW)).toEqual([
      { alias: "alpha", url: "http://alpha.local", ageMs: 8 * DAY_MS },
      { alias: "brokenClock", url: "http://broken.local", ageMs: null },
      { alias: "zebra", url: "http://zebra.local", ageMs: 10 * DAY_MS },
    ]);
  });

  test("returns an empty list when the peer store is absent or unreadable", () => {
    expect(findStalePeers(NOW)).toEqual([]);

    writeFileSync(join(tempDir, "peers.json"), "{ this is not json", "utf-8");

    expect(findStalePeers(NOW)).toEqual([]);
  });
});

describe("checkStalePeers", () => {
  test("reports the no-stale, singular, and plural doctor check outcomes", () => {
    process.env.MAW_PEER_STALE_TTL_MS = String(2 * DAY_MS);
    writePeers({ fresh: { url: "http://fresh.local", node: null, addedAt: isoDaysAgo(1), lastSeen: null } });

    expect(checkStalePeers(NOW)).toEqual({ name: "peers:stale", ok: true, message: "no stale peers" });

    writePeers({ old: { url: "http://old.local", node: null, addedAt: isoDaysAgo(3), lastSeen: null } });

    expect(checkStalePeers(NOW)).toEqual({
      name: "peers:stale",
      ok: false,
      message: "1 stale peer (>2d) — run 'maw doctor --fix-stale' to remove",
    });

    writePeers({
      old: { url: "http://old.local", node: null, addedAt: isoDaysAgo(3), lastSeen: null },
      older: { url: "http://older.local", node: null, addedAt: isoDaysAgo(4), lastSeen: null },
    });

    expect(checkStalePeers(NOW)).toEqual({
      name: "peers:stale",
      ok: false,
      message: "2 stale peers (>2d) — run 'maw doctor --fix-stale' to remove",
    });
  });
});

describe("cmdFixStalePeers", () => {
  test("prints a deterministic preview, removes stale peers in test mode, and preserves fresh peers", async () => {
    process.env.MAW_TEST_MODE = "1";
    process.env.MAW_PEER_STALE_TTL_MS = String(7 * DAY_MS);
    writePeers({
      old: { url: "http://old.local", node: null, addedAt: isoDaysAgo(30), lastSeen: isoDaysAgo(9) },
      never: { url: "http://never.local", node: null, addedAt: isoDaysAgo(10), lastSeen: null },
      fresh: { url: "http://fresh.local", node: null, addedAt: isoDaysAgo(30), lastSeen: isoDaysAgo(1) },
    });

    const result = await cmdFixStalePeers();

    expect(result).toEqual({ ok: true, checks: [{ name: "peers:fix-stale", ok: true, message: "removed 2 stale peers" }] });
    expect(Object.keys(readPeers()).sort()).toEqual(["fresh"]);
    expect(logs.join("\n")).toContain("2 stale peers to remove");
    expect(logs.join("\n")).toContain("never");
    expect(logs.join("\n")).toContain("10d ago");
    expect(logs.join("\n")).toContain("removed old");
    expect(logs.join("\n")).toContain("peers:fix-stale: removed 2 stale peers");
  });


  test("runs the abort countdown outside test mode before removing stale peers", async () => {
    process.env.MAW_PEER_STALE_TTL_MS = String(1 * DAY_MS);
    delete process.env.MAW_TEST_MODE;
    writePeers({ stale: { url: "http://stale.local", node: null, addedAt: isoDaysAgo(3), lastSeen: null } });
    const writes: string[] = [];
    Bun.sleep = (async () => {}) as typeof Bun.sleep;
    process.stdout.write = ((chunk: any) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;

    await expect(cmdFixStalePeers()).resolves.toEqual({
      ok: true,
      checks: [{ name: "peers:fix-stale", ok: true, message: "removed 1 stale peer" }],
    });

    expect(writes.join("\n")).toContain("3...");
    expect(writes.join("\n")).toContain("1...");
    expect(readPeers()).toEqual({});
  });

  test("short-circuits with an ok check when there is nothing to remove", async () => {
    process.env.MAW_TEST_MODE = "1";
    writePeers({ fresh: { url: "http://fresh.local", node: null, addedAt: isoDaysAgo(1), lastSeen: null } });

    await expect(cmdFixStalePeers()).resolves.toEqual({
      ok: true,
      checks: [{ name: "peers:fix-stale", ok: true, message: "no stale peers" }],
    });
    expect(readPeers()).toHaveProperty("fresh");
    expect(logs.join("\n")).toContain("peers:fix-stale: no stale peers to remove");
  });
});
