/**
 * should-auto-wake-manifest.test.ts — Sub-PR 4 of #841.
 *
 * Verifies that `shouldAutoWake()` accepts an optional `OracleManifestEntry`
 * (added in #838) and derives `isFleetKnown` / `isLive` from it. Companion
 * to test/isolated/should-auto-wake.test.ts (#835), which covers the
 * flag-based variant.
 *
 * Decisions covered:
 *   - manifest with `fleet` source + isLive=false        → wake (parity with isFleetKnown=true,isLive=false)
 *   - manifest WITHOUT `fleet` source                    → skip (parity with isFleetKnown=false)
 *   - manifest with isLive=true                          → skip (live targets never auto-wake)
 *   - manifest absent + flags provided                   → existing behavior preserved
 *   - manifest provided AND flags also provided          → MANIFEST WINS (documented in opts.manifest)
 *   - manifest=undefined explicitly                      → falls back to flags (treated as "no entry")
 *   - flag overrides (--wake / --no-wake) still apply on top of manifest
 *
 * Pure-unit (no I/O); kept under test/isolated/ for convention parity with
 * the #835 suite — no mock.module() needed.
 */
import { describe, test, expect } from "bun:test";
import { shouldAutoWake } from "../../src/commands/shared/should-auto-wake";
import type { OracleManifestEntry } from "../../src/lib/oracle-manifest";

/** Helper — build a manifest entry with overridable defaults. */
function entry(overrides: Partial<OracleManifestEntry> = {}): OracleManifestEntry {
  return {
    name: "neo",
    sources: [],
    isLive: false,
    ...overrides,
  };
}

describe("shouldAutoWake — manifest input (Sub-PR 4 of #841)", () => {
  // ── Manifest derives isFleetKnown from sources.includes("fleet") ─────────
  describe("manifest → isFleetKnown derivation", () => {
    test("fleet source + not live → wake (view)", () => {
      const m = entry({ sources: ["fleet"], isLive: false });
      const d = shouldAutoWake("neo", { site: "view", manifest: m });
      expect(d.wake).toBe(true);
      expect(d.reason).toContain("fleet-known");
    });

    test("fleet source + not live → wake (hey)", () => {
      const m = entry({ sources: ["fleet"], isLive: false });
      const d = shouldAutoWake("neo", { site: "hey", manifest: m });
      expect(d.wake).toBe(true);
      expect(d.reason).toContain("fleet-known");
    });

    test("fleet source + not live → wake (api-send)", () => {
      const m = entry({ sources: ["fleet"], isLive: false });
      const d = shouldAutoWake("neo", { site: "api-send", manifest: m });
      expect(d.wake).toBe(true);
      expect(d.reason).toContain("fleet-known");
    });

    test("no fleet source (only oracles-json) → skip on hey", () => {
      // Oracle is in oracles.json (filesystem-discovered) but not in fleet
      // config. Per #549 + #780 we don't auto-wake unless fleet pinned it.
      const m = entry({ sources: ["oracles-json"], isLive: false });
      const d = shouldAutoWake("neo", { site: "hey", manifest: m });
      expect(d.wake).toBe(false);
      expect(d.reason).toContain("unknown");
    });

    test("session+agent sources but no fleet → skip on view (caller asks)", () => {
      const m = entry({ sources: ["session", "agent"], isLive: false });
      const d = shouldAutoWake("neo", { site: "view", manifest: m });
      expect(d.wake).toBe(false);
      expect(d.reason).toContain("caller should ask");
    });

    test("multi-source including fleet → still treated as fleet-known", () => {
      const m = entry({ sources: ["fleet", "session", "oracles-json"], isLive: false });
      const d = shouldAutoWake("neo", { site: "hey", manifest: m });
      expect(d.wake).toBe(true);
    });
  });

  // ── Manifest derives isLive from entry.isLive ────────────────────────────
  describe("manifest → isLive derivation", () => {
    test("fleet source + already live → skip on view", () => {
      const m = entry({ sources: ["fleet"], isLive: true });
      const d = shouldAutoWake("neo", { site: "view", manifest: m });
      expect(d.wake).toBe(false);
      expect(d.reason).toContain("already running");
    });

    test("fleet source + already live → skip on hey", () => {
      const m = entry({ sources: ["fleet"], isLive: true });
      const d = shouldAutoWake("neo", { site: "hey", manifest: m });
      expect(d.wake).toBe(false);
      expect(d.reason).toContain("already running");
    });

    test("wake-cmd: live manifest → no-op skip", () => {
      const m = entry({ sources: ["fleet"], isLive: true });
      const d = shouldAutoWake("neo", { site: "wake-cmd", manifest: m });
      expect(d.wake).toBe(false);
      expect(d.reason).toContain("already live");
    });

    test("wake-cmd: dead manifest → wake", () => {
      const m = entry({ sources: ["fleet"], isLive: false });
      const d = shouldAutoWake("neo", { site: "wake-cmd", manifest: m });
      expect(d.wake).toBe(true);
      expect(d.reason).toContain("missing");
    });
  });

  // ── Backwards compatibility: manifest absent ─────────────────────────────
  describe("manifest absent → flag-based behavior preserved", () => {
    test("flags-only call still works (no manifest field)", () => {
      const d = shouldAutoWake("neo", {
        site: "hey",
        isFleetKnown: true,
        isLive: false,
      });
      expect(d.wake).toBe(true);
      expect(d.reason).toContain("fleet-known");
    });

    test("explicit manifest:undefined treated identically to missing field", () => {
      const d = shouldAutoWake("neo", {
        site: "hey",
        isFleetKnown: true,
        isLive: false,
        manifest: undefined,
      });
      expect(d.wake).toBe(true);
    });
  });

  // ── Manifest WINS when both manifest and flags are provided ──────────────
  describe("manifest provided AND flags provided → manifest wins", () => {
    test("manifest says fleet-known, flag says NOT fleet-known → manifest wins (wake)", () => {
      const m = entry({ sources: ["fleet"], isLive: false });
      const d = shouldAutoWake("neo", {
        site: "hey",
        isFleetKnown: false, // contradicts manifest
        isLive: false,
        manifest: m,
      });
      expect(d.wake).toBe(true);
      expect(d.reason).toContain("fleet-known");
    });

    test("manifest says NOT fleet-known, flag says fleet-known → manifest wins (skip)", () => {
      const m = entry({ sources: ["oracles-json"], isLive: false });
      const d = shouldAutoWake("neo", {
        site: "hey",
        isFleetKnown: true, // contradicts manifest
        isLive: false,
        manifest: m,
      });
      expect(d.wake).toBe(false);
      expect(d.reason).toContain("unknown");
    });

    test("manifest says live, flag says not live → manifest wins (skip)", () => {
      const m = entry({ sources: ["fleet"], isLive: true });
      const d = shouldAutoWake("neo", {
        site: "view",
        isLive: false, // contradicts manifest
        manifest: m,
      });
      expect(d.wake).toBe(false);
      expect(d.reason).toContain("already running");
    });
  });

  // ── Operator flags (--wake / --no-wake) still override manifest ──────────
  describe("operator flags override manifest", () => {
    test("--no-wake skips even when manifest says fleet-known + dead", () => {
      const m = entry({ sources: ["fleet"], isLive: false });
      const d = shouldAutoWake("neo", { site: "hey", manifest: m, noWake: true });
      expect(d.wake).toBe(false);
      expect(d.reason).toBe("--no-wake explicit deny");
    });

    test("--wake forces even when manifest has no fleet source", () => {
      const m = entry({ sources: ["oracles-json"], isLive: false });
      const d = shouldAutoWake("neo", { site: "view", manifest: m, force: true });
      expect(d.wake).toBe(true);
      expect(d.reason).toBe("--wake explicit force");
    });

    test("hey + canonical target wins over manifest fleet-known", () => {
      const m = entry({ sources: ["fleet"], isLive: false });
      const d = shouldAutoWake("neo", {
        site: "hey",
        manifest: m,
        isCanonicalTarget: true,
      });
      expect(d.wake).toBe(false);
      expect(d.reason).toContain("canonical");
    });
  });

  // ── Fixed-contract sites ignore manifest ─────────────────────────────────
  describe("fixed-contract sites ignore manifest", () => {
    test("peek never wakes — even with fleet-known manifest", () => {
      const m = entry({ sources: ["fleet"], isLive: false });
      const d = shouldAutoWake("neo", { site: "peek", manifest: m });
      expect(d.wake).toBe(false);
    });

    test("api-wake always wakes — even with live manifest", () => {
      const m = entry({ sources: ["fleet"], isLive: true });
      const d = shouldAutoWake("neo", { site: "api-wake", manifest: m });
      expect(d.wake).toBe(true);
    });

    test("bud always wakes — even with live manifest", () => {
      const m = entry({ sources: ["fleet"], isLive: true });
      const d = shouldAutoWake("neo", { site: "bud", manifest: m });
      expect(d.wake).toBe(true);
    });
  });
});
