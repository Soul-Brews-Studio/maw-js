/**
 * should-auto-wake.test.ts — #835 (Sub-issue 1 of #736 Phase 2).
 *
 * Pure-unit tests for the unified `shouldAutoWake(oracle, opts)` helper that
 * replaces 7 independent auto-wake decisions across maw-js call sites.
 *
 * The helper is pure (no I/O, no module dependencies) so this file lives in
 * test/isolated only because the convention there is "no live tmux/sdk."
 * No mock.module() is required.
 *
 * Coverage matrix (each site × decision-affecting inputs):
 *   - peek      : never wakes, regardless of inputs
 *   - api-wake  : always wakes, regardless of inputs
 *   - bud       : always wakes (no --no-wake escape)
 *   - wake-cmd  : wake iff !isLive
 *   - view      : --no-wake skip / --wake force / fleet-known + !isLive wake /
 *                 unknown ⇒ caller-asks (wake=false, ask reason)
 *   - hey       : --no-wake skip / --wake force / canonical-target skip /
 *                 fleet-known + !isLive wake / else skip
 *   - api-send  : fleet-known + !isLive wake / else skip
 */
import { describe, test, expect } from "bun:test";
import { shouldAutoWake } from "../../src/commands/shared/should-auto-wake";

describe("shouldAutoWake — pure decision helper (#835)", () => {
  // ── peek (never wakes) ───────────────────────────────────────────────────
  describe("site=peek", () => {
    test("never wakes — bare query", () => {
      const d = shouldAutoWake("neo", { site: "peek" });
      expect(d.wake).toBe(false);
      expect(d.reason).toBe("peek never auto-wakes");
    });

    test("never wakes — even when fleet-known and not live", () => {
      const d = shouldAutoWake("volt", { site: "peek", isFleetKnown: true, isLive: false });
      expect(d.wake).toBe(false);
    });

    test("never wakes — even with force flag (peek ignores flags)", () => {
      const d = shouldAutoWake("volt", { site: "peek", force: true });
      expect(d.wake).toBe(false);
    });
  });

  // ── api-wake (always wakes) ──────────────────────────────────────────────
  describe("site=api-wake", () => {
    test("always wakes — even when isLive=true (idempotent endpoint)", () => {
      const d = shouldAutoWake("samba", { site: "api-wake", isLive: true });
      expect(d.wake).toBe(true);
      expect(d.reason).toBe("api-wake endpoint always wakes");
    });

    test("always wakes — even when not fleet-known", () => {
      const d = shouldAutoWake("anything", { site: "api-wake", isFleetKnown: false });
      expect(d.wake).toBe(true);
    });

    test("always wakes — ignores noWake flag (endpoint contract is fixed)", () => {
      const d = shouldAutoWake("samba", { site: "api-wake", noWake: true });
      expect(d.wake).toBe(true);
    });
  });

  // ── bud (always wakes a fresh bud) ───────────────────────────────────────
  describe("site=bud", () => {
    test("always wakes — fresh bud has no session by definition", () => {
      const d = shouldAutoWake("brand-new", { site: "bud" });
      expect(d.wake).toBe(true);
      expect(d.reason).toBe("bud always wakes new oracle");
    });

    test("always wakes — bud ignores noWake (--no-wake escape disabled)", () => {
      const d = shouldAutoWake("fresh-bud", { site: "bud", noWake: true });
      expect(d.wake).toBe(true);
    });
  });

  // ── wake-cmd (idempotent: wake iff !isLive) ──────────────────────────────
  describe("site=wake-cmd", () => {
    test("wakes when not live", () => {
      const d = shouldAutoWake("neo", { site: "wake-cmd", isLive: false });
      expect(d.wake).toBe(true);
      expect(d.reason).toContain("missing");
    });

    test("skips (no-op) when already live", () => {
      const d = shouldAutoWake("neo", { site: "wake-cmd", isLive: true });
      expect(d.wake).toBe(false);
      expect(d.reason).toContain("already live");
    });

    test("--no-wake explicit deny wins over !isLive", () => {
      const d = shouldAutoWake("neo", { site: "wake-cmd", isLive: false, noWake: true });
      expect(d.wake).toBe(false);
      expect(d.reason).toBe("--no-wake explicit deny");
    });

    test("--wake explicit force wins over isLive=true", () => {
      const d = shouldAutoWake("neo", { site: "wake-cmd", isLive: true, force: true });
      expect(d.wake).toBe(true);
      expect(d.reason).toBe("--wake explicit force");
    });
  });

  // ── view (#549 + #780 fleet-known silent wake) ───────────────────────────
  describe("site=view", () => {
    test("wakes when fleet-known and not live", () => {
      const d = shouldAutoWake("volt", { site: "view", isFleetKnown: true, isLive: false });
      expect(d.wake).toBe(true);
      expect(d.reason).toContain("fleet-known");
    });

    test("skips when fleet-known but already live", () => {
      const d = shouldAutoWake("volt", { site: "view", isFleetKnown: true, isLive: true });
      expect(d.wake).toBe(false);
      expect(d.reason).toContain("already running");
    });

    test("skips with caller-ask reason when unknown name", () => {
      const d = shouldAutoWake("typo", { site: "view", isFleetKnown: false, isLive: false });
      expect(d.wake).toBe(false);
      expect(d.reason).toContain("caller should ask");
    });

    test("--no-wake skips even if fleet-known + dead", () => {
      const d = shouldAutoWake("volt", {
        site: "view",
        isFleetKnown: true,
        isLive: false,
        noWake: true,
      });
      expect(d.wake).toBe(false);
      expect(d.reason).toBe("--no-wake explicit deny");
    });

    test("--wake forces even on unknown name", () => {
      const d = shouldAutoWake("typo", { site: "view", isFleetKnown: false, force: true });
      expect(d.wake).toBe(true);
      expect(d.reason).toBe("--wake explicit force");
    });

    test("--no-wake wins over --wake (explicit deny beats explicit allow)", () => {
      const d = shouldAutoWake("volt", {
        site: "view",
        isFleetKnown: true,
        force: true,
        noWake: true,
      });
      expect(d.wake).toBe(false);
      expect(d.reason).toBe("--no-wake explicit deny");
    });
  });

  // ── hey (#780 + #791) ────────────────────────────────────────────────────
  describe("site=hey", () => {
    test("wakes when fleet-known and not live (parity with view)", () => {
      const d = shouldAutoWake("volt", { site: "hey", isFleetKnown: true, isLive: false });
      expect(d.wake).toBe(true);
      expect(d.reason).toContain("fleet-known");
    });

    test("skips when fleet-known but already live", () => {
      const d = shouldAutoWake("volt", { site: "hey", isFleetKnown: true, isLive: true });
      expect(d.wake).toBe(false);
    });

    test("skips on canonical 3-part target (#791)", () => {
      const d = shouldAutoWake("volt", {
        site: "hey",
        isFleetKnown: true,
        isLive: false,
        isCanonicalTarget: true,
      });
      expect(d.wake).toBe(false);
      expect(d.reason).toContain("canonical");
    });

    test("skips when unknown target", () => {
      const d = shouldAutoWake("typo", { site: "hey", isFleetKnown: false, isLive: false });
      expect(d.wake).toBe(false);
      expect(d.reason).toContain("unknown");
    });

    test("--no-wake honored", () => {
      const d = shouldAutoWake("volt", {
        site: "hey",
        isFleetKnown: true,
        isLive: false,
        noWake: true,
      });
      expect(d.wake).toBe(false);
    });

    test("--wake force overrides isCanonicalTarget", () => {
      const d = shouldAutoWake("volt", {
        site: "hey",
        isFleetKnown: true,
        isLive: false,
        isCanonicalTarget: true,
        force: true,
      });
      expect(d.wake).toBe(true);
      expect(d.reason).toBe("--wake explicit force");
    });
  });

  // ── api-send (implicit wake on send) ────────────────────────────────────
  describe("site=api-send", () => {
    test("wakes fleet-known target with no live session", () => {
      const d = shouldAutoWake("samba", {
        site: "api-send",
        isFleetKnown: true,
        isLive: false,
      });
      expect(d.wake).toBe(true);
      expect(d.reason).toContain("fleet-known");
    });

    test("skips when target already live", () => {
      const d = shouldAutoWake("samba", {
        site: "api-send",
        isFleetKnown: true,
        isLive: true,
      });
      expect(d.wake).toBe(false);
    });

    test("skips when unknown target (preserves 404)", () => {
      const d = shouldAutoWake("not-a-real-oracle", {
        site: "api-send",
        isFleetKnown: false,
        isLive: false,
      });
      expect(d.wake).toBe(false);
      expect(d.reason).toContain("unknown");
    });
  });

  // ── invariants across sites ─────────────────────────────────────────────
  describe("invariants", () => {
    test("every decision returns a non-empty reason string", () => {
      const cases: Array<Parameters<typeof shouldAutoWake>[1]> = [
        { site: "peek" },
        { site: "api-wake" },
        { site: "bud" },
        { site: "wake-cmd", isLive: false },
        { site: "wake-cmd", isLive: true },
        { site: "view", isFleetKnown: true, isLive: false },
        { site: "view", isFleetKnown: false },
        { site: "hey", isFleetKnown: true, isLive: false },
        { site: "hey", isCanonicalTarget: true },
        { site: "api-send", isFleetKnown: true, isLive: false },
      ];
      for (const opts of cases) {
        const d = shouldAutoWake("x", opts);
        expect(typeof d.wake).toBe("boolean");
        expect(typeof d.reason).toBe("string");
        expect(d.reason.length).toBeGreaterThan(0);
      }
    });

    test("peek + bud + api-wake ignore force / noWake (fixed contract)", () => {
      // peek: noWake doesn't matter — already false
      expect(shouldAutoWake("x", { site: "peek", force: true }).wake).toBe(false);
      // api-wake: noWake doesn't matter — always true
      expect(shouldAutoWake("x", { site: "api-wake", noWake: true }).wake).toBe(true);
      // bud: noWake doesn't matter — always true
      expect(shouldAutoWake("x", { site: "bud", noWake: true }).wake).toBe(true);
    });
  });
});
