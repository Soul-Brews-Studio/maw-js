/**
 * ls-new.test.ts — `maw oracle ls --new` (#1273) unit-level coverage.
 *
 * This file holds the env-free unit tests:
 *   - parseDuration grammar
 *   - parseSince ISO parsing
 *   - resolveCreatedAt 4-tier cascade (via injected deps — no Bun.spawn)
 *   - preprocessNewFlag CLI argv shim
 *
 * The end-to-end tests that exercise `cmdOracleList` with --new / --since
 * mutate `MAW_CONFIG_DIR` and therefore live in test/isolated/
 * (oracle-ls-new.test.ts) — the same convention used by
 * oracle-ls-manifest.test.ts. The two files together cover the spec.
 */
import { describe, test, expect } from "bun:test";
import {
  parseDuration,
  parseSince,
  resolveCreatedAt,
  resolveCreatedAtWithCache,
  type OracleBirthsCache,
} from "../../../src/commands/plugins/oracle/impl-helpers";
import { preprocessNewFlag } from "../../../src/commands/plugins/oracle";

function makeEntry(over: Partial<any> = {}): any {
  return {
    org: "Soul-Brews-Studio",
    repo: `${over.name ?? "alpha"}-oracle`,
    name: over.name ?? "alpha",
    local_path: `/tmp/${over.name ?? "alpha"}-oracle`,
    has_psi: true,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: new Date().toISOString(),
    ...over,
  };
}

// ─── Cascade priority (mock all 4 tiers) ─────────────────────────────────────

describe("resolveCreatedAt cascade order (#1273)", () => {
  test("Tier 1 (budded_at) wins when present", async () => {
    const entry = makeEntry({
      name: "tier1",
      budded_at: "2026-05-01T00:00:00.000Z",
    });
    const result = await resolveCreatedAt(entry, {
      gitFirstCommitDate: async () => "2026-04-01T00:00:00.000Z",
      fleetConfigBirthtime: () => new Date("2026-03-01T00:00:00.000Z"),
      claudeMdBirthtime: () => new Date("2026-02-01T00:00:00.000Z"),
    });
    expect(result.source).toBe("budded_at");
    expect(result.iso).toBe("2026-05-01T00:00:00.000Z");
  });

  test("Tier 2 (git-claudemd) wins when no budded_at but has local_path", async () => {
    const entry = makeEntry({ name: "tier2", local_path: "/tmp/tier2-oracle" });
    const result = await resolveCreatedAt(entry, {
      gitFirstCommitDate: async () => "2026-04-15T12:00:00.000Z",
      fleetConfigBirthtime: () => new Date("2026-03-01T00:00:00.000Z"),
      claudeMdBirthtime: () => new Date("2026-02-01T00:00:00.000Z"),
    });
    expect(result.source).toBe("git-claudemd");
    expect(result.iso).toBe("2026-04-15T12:00:00.000Z");
  });

  test("Tier 3 (fleet-birth) wins when git returns null", async () => {
    const entry = makeEntry({ name: "tier3", local_path: "/tmp/tier3-oracle" });
    const fleetBirth = new Date("2026-03-10T08:00:00.000Z");
    const result = await resolveCreatedAt(entry, {
      gitFirstCommitDate: async () => null,
      fleetConfigBirthtime: () => fleetBirth,
      claudeMdBirthtime: () => new Date("2026-02-01T00:00:00.000Z"),
    });
    expect(result.source).toBe("fleet-birth");
    expect(result.iso).toBe(fleetBirth.toISOString());
  });

  test("Tier 4 (fs-birth) wins when prior tiers return null", async () => {
    const entry = makeEntry({ name: "tier4", local_path: "/tmp/tier4-oracle" });
    const cb = new Date("2026-02-05T10:00:00.000Z");
    const result = await resolveCreatedAt(entry, {
      gitFirstCommitDate: async () => null,
      fleetConfigBirthtime: () => null,
      claudeMdBirthtime: () => cb,
    });
    expect(result.source).toBe("fs-birth");
    expect(result.iso).toBe(cb.toISOString());
  });

  test("'unknown' when no tier yields a value", async () => {
    const entry = makeEntry({ name: "ghost", local_path: "" });
    const result = await resolveCreatedAt(entry, {
      gitFirstCommitDate: async () => null,
      fleetConfigBirthtime: () => null,
      claudeMdBirthtime: () => null,
    });
    expect(result.source).toBe("unknown");
    expect(result.iso).toBeNull();
  });
});

// ─── parseDuration / parseSince ──────────────────────────────────────────────

describe("parseDuration grammar", () => {
  test("accepts seconds/minutes/hours/days/weeks", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(5 * 60_000);
    expect(parseDuration("2h")).toBe(2 * 3_600_000);
    expect(parseDuration("7d")).toBe(7 * 86_400_000);
    expect(parseDuration("2w")).toBe(14 * 86_400_000);
  });
  test("rejects malformed input", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("7")).toBeNull();
    expect(parseDuration("d")).toBeNull();
    expect(parseDuration("7days")).toBeNull();
    expect(parseDuration("-5d")).toBeNull();
    expect(parseDuration("0d")).toBeNull();
    expect(parseDuration("1y")).toBeNull();
  });
});

describe("parseSince", () => {
  test("parses ISO dates", () => {
    const d = parseSince("2026-05-10");
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2026);
  });
  test("rejects nonsense", () => {
    expect(parseSince("not-a-date")).toBeNull();
    expect(parseSince("")).toBeNull();
  });
});

// ─── In-memory cache behavior (no filesystem) ────────────────────────────────

describe("resolveCreatedAtWithCache (in-memory contract)", () => {
  test("caches git tier and reuses on second call", async () => {
    const entry = makeEntry({
      name: "cached",
      budded_at: null,
      local_path: "/tmp/cached-oracle",
    });
    let gitCalls = 0;
    const cache: OracleBirthsCache = { version: 1, entries: {} };
    const deps = {
      gitFirstCommitDate: async () => {
        gitCalls++;
        return "2026-05-11T00:00:00.000Z";
      },
      fleetConfigBirthtime: () => null,
      claudeMdBirthtime: () => null,
    };
    const r1 = await resolveCreatedAtWithCache(entry, cache, deps);
    expect(r1.source).toBe("git-claudemd");
    expect(gitCalls).toBe(1);

    const r2 = await resolveCreatedAtWithCache(entry, cache, deps);
    expect(r2.source).toBe("git-claudemd");
    expect(r2.iso).toBe(r1.iso);
    expect(gitCalls).toBe(1); // cache hit, no second shell-out
  });

  test("budded_at short-circuits cache (never consults git tier)", async () => {
    const entry = makeEntry({
      name: "budded",
      budded_at: "2026-05-09T00:00:00.000Z",
      local_path: "/tmp/budded-oracle",
    });
    let gitCalls = 0;
    const cache: OracleBirthsCache = { version: 1, entries: {} };
    const r = await resolveCreatedAtWithCache(entry, cache, {
      gitFirstCommitDate: async () => {
        gitCalls++;
        return "ignored";
      },
    });
    expect(r.source).toBe("budded_at");
    expect(gitCalls).toBe(0);
  });

  test("'unknown' results are not cached (so we retry next time)", async () => {
    const entry = makeEntry({
      name: "ghost",
      budded_at: null,
      local_path: "",
    });
    const cache: OracleBirthsCache = { version: 1, entries: {} };
    const r = await resolveCreatedAtWithCache(entry, cache, {
      gitFirstCommitDate: async () => null,
      fleetConfigBirthtime: () => null,
      claudeMdBirthtime: () => null,
    });
    expect(r.source).toBe("unknown");
    expect(cache.entries.ghost).toBeUndefined();
  });
});

// ─── preprocessNewFlag (CLI surface) ─────────────────────────────────────────

describe("preprocessNewFlag (#1273 CLI surface)", () => {
  test("bare --new becomes --new=7d", () => {
    const out = preprocessNewFlag(["ls", "--new"]);
    expect(out).toEqual(["ls", "--new=7d"]);
  });
  test("--new=24h passes through unchanged", () => {
    const out = preprocessNewFlag(["ls", "--new=24h"]);
    expect(out).toEqual(["ls", "--new=24h"]);
  });
  test("--new 24h (space form) is left for arg to consume", () => {
    const out = preprocessNewFlag(["ls", "--new", "24h"]);
    expect(out).toEqual(["ls", "--new", "24h"]);
  });
  test("bare --new followed by non-duration token becomes --new=7d", () => {
    const out = preprocessNewFlag(["ls", "--new", "--json"]);
    expect(out).toEqual(["ls", "--new=7d", "--json"]);
  });
});
