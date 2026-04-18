/**
 * Tests for src/api/cross-team-queue.ts + cross-team-queue-scan.ts
 * Day 2 (ADR-002) — filesystem scan + frontmatter parse + query filters
 *
 * Covers NEXUS peer-review gotchas + VELA design §3.4 edge cases:
 *   G1 — Number() NaN guard on maxAgeHours / limit
 *   G2 — actionRequired enum validation (banana → default yes)
 *   G3 — relPath semantics (relative to VAULT_ROOT = ψ/memory)
 *   G4 — ageHours = max(date, mtime)
 *   A1 — recipient list sanitization (comma split, reject ;/quotes)
 *   + 3 malformed-frontmatter cases (missing, unclosed, non-ASCII)
 *   + team classification (software/business/cross/unknown)
 *   + empty-inbox accumulation
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { Elysia } from "elysia";
import { join } from "path";
import { scanCrossTeamQueue } from "../src/api/cross-team-queue-scan";
import { crossTeamQueueApi } from "../src/api/cross-team-queue";
import type { CrossTeamQueueResponse } from "../src/shared/cross-team-queue.types";

const FIXTURE_VAULT = join(import.meta.dir, "fixtures", "ctq", "memory");

beforeAll(() => {
  process.env.CTQ_VAULT_ROOT = FIXTURE_VAULT;
});

// ─── Scan module (direct) ───────────────────────────────────────────────

describe("scanCrossTeamQueue — filesystem + frontmatter", () => {
  test("scans all oracle inboxes under vault root", () => {
    const scan = scanCrossTeamQueue(FIXTURE_VAULT);
    expect(scan.scannedFileCount).toBeGreaterThanOrEqual(6); // 4 normal + 2 malformed + 1 thai
  });

  test("parses well-formed frontmatter items", () => {
    const scan = scanCrossTeamQueue(FIXTURE_VAULT);
    const item = scan.items.find((i) => i.filename === "2026-04-17_normal-action-yes.md");
    expect(item).toBeDefined();
    expect(item!.from).toBe("nexus");
    expect(item!.to).toBe("forge");
    expect(item!.type).toBe("dvl-request");
    expect(item!.tags).toEqual(["safety-hooks", "regex", "peer-review"]);
    expect(item!.confidence).toBe("high");
    expect(item!.actionRequired).toBe(true);
    expect(item!.priority).toBe("medium");
    expect(item!.team).toBe("software");
  });

  test("multi-line indented `related:` list parses correctly", () => {
    const scan = scanCrossTeamQueue(FIXTURE_VAULT);
    const item = scan.items.find((i) => i.filename === "2026-04-17_normal-action-yes.md");
    expect(item!.related.length).toBe(2);
    expect(item!.related[0]).toContain("pass-2-bypass-set.md");
  });

  test("action_required: yes (reason) parses hint", () => {
    const scan = scanCrossTeamQueue(FIXTURE_VAULT);
    const item = scan.items.find((i) => i.filename === "2026-04-18_action-yes-with-hint.md");
    expect(item!.actionRequired).toBe(true);
    expect(item!.actionHint).toBe("review schema + answer 5 Qs");
  });

  test("action_required: no is respected (appears in items with actionRequired=false)", () => {
    const scan = scanCrossTeamQueue(FIXTURE_VAULT);
    const item = scan.items.find((i) => i.filename === "2026-04-18_inline-tags.md");
    expect(item!.actionRequired).toBe(false);
  });

  test("relPath is relative to vault root (G3)", () => {
    const scan = scanCrossTeamQueue(FIXTURE_VAULT);
    const item = scan.items.find((i) => i.filename === "2026-04-17_normal-action-yes.md");
    expect(item!.relPath).toBe("forge/inbox/2026-04-17_normal-action-yes.md");
    // Must NOT start with "memory/" or "ψ/memory/" or absolute path
    expect(item!.relPath.startsWith("/")).toBe(false);
    expect(item!.relPath.startsWith("memory/")).toBe(false);
  });

  test("business-team recipient (david) classified correctly", () => {
    const scan = scanCrossTeamQueue(FIXTURE_VAULT);
    const item = scan.items.find((i) => i.filename === "2026-04-17_business-team.md");
    expect(item!.team).toBe("business");
  });

  test("software-team recipient classified correctly", () => {
    const scan = scanCrossTeamQueue(FIXTURE_VAULT);
    const forgeItems = scan.items.filter((i) => i.to === "forge");
    forgeItems.forEach((i) => expect(i.team).toBe("software"));
  });

  test("ageHours uses max(date, mtime) — never negative (G4)", () => {
    const scan = scanCrossTeamQueue(FIXTURE_VAULT);
    scan.items.forEach((i) => {
      expect(i.ageHours).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(i.ageHours)).toBe(true);
    });
  });

  test("non-ASCII (Thai) title extracted correctly", () => {
    const scan = scanCrossTeamQueue(FIXTURE_VAULT);
    const item = scan.items.find((i) => i.filename === "2026-04-18_thai-title.md");
    expect(item).toBeDefined();
    expect(item!.title).toContain("ตอกตรงจุด");
  });

  test("malformed: missing frontmatter → error, not silent drop", () => {
    const scan = scanCrossTeamQueue(FIXTURE_VAULT);
    const err = scan.errors.find((e) => e.path.includes("missing-frontmatter"));
    expect(err).toBeDefined();
    expect(err!.reason).toContain("no frontmatter");
    // And NOT in items
    const item = scan.items.find((i) => i.filename === "2026-04-16_missing-frontmatter.md");
    expect(item).toBeUndefined();
  });

  test("malformed: unclosed YAML → error", () => {
    const scan = scanCrossTeamQueue(FIXTURE_VAULT);
    const err = scan.errors.find((e) => e.path.includes("unclosed-yaml"));
    expect(err).toBeDefined();
  });

  test("empty inbox (pace) accumulates in emptyInboxes", () => {
    const scan = scanCrossTeamQueue(FIXTURE_VAULT);
    expect(scan.emptyInboxes).toContain("pace");
  });

  test("scan completes under 500ms for fixture (performance budget)", () => {
    const t0 = Date.now();
    scanCrossTeamQueue(FIXTURE_VAULT);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
  });
});

// ─── Handler (Elysia via .handle) ───────────────────────────────────────

async function hit(url: string): Promise<CrossTeamQueueResponse> {
  const app = new Elysia({ prefix: "/api" }).use(crossTeamQueueApi);
  const res = await app.handle(new Request(`http://localhost${url}`));
  return res.json() as Promise<CrossTeamQueueResponse>;
}

describe("GET /api/cross-team-queue — contract + filters", () => {
  test("default query: schema v1 + action_required=yes items only", async () => {
    const r = await hit("/api/cross-team-queue");
    expect(r.schemaVersion).toBe(1);
    expect(typeof r.scannedAt).toBe("string");
    expect(r.scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.scannedFileCount).toBeGreaterThan(0);
    // All items default-filtered to actionRequired=true
    r.items.forEach((i) => expect(i.actionRequired).toBe(true));
  });

  test("actionRequired=all returns both yes and no items", async () => {
    const r = await hit("/api/cross-team-queue?actionRequired=all");
    const hasYes = r.items.some((i) => i.actionRequired);
    const hasNo = r.items.some((i) => !i.actionRequired);
    expect(hasYes).toBe(true);
    expect(hasNo).toBe(true);
  });

  test("G1: maxAgeHours=abc → NaN guarded → no filter applied (not empty result)", async () => {
    const r = await hit("/api/cross-team-queue?maxAgeHours=abc");
    // With NaN coerced to undefined, no maxAge filter → returns all yes items
    expect(r.total).toBeGreaterThan(0);
  });

  test("G1: maxAgeHours=-5 rejected (not allowed as negative)", async () => {
    const r = await hit("/api/cross-team-queue?maxAgeHours=-5");
    // Negative → undefined → no filter
    expect(r.total).toBeGreaterThan(0);
  });

  test("G2: actionRequired=banana → defaults to yes (not empty)", async () => {
    const r = await hit("/api/cross-team-queue?actionRequired=banana");
    r.items.forEach((i) => expect(i.actionRequired).toBe(true));
    expect(r.total).toBeGreaterThan(0);
  });

  test("A1: recipient with semicolon rejected → empty filter → all items", async () => {
    const r = await hit("/api/cross-team-queue?recipient=forge%3Bevil");
    // Semicolon detected → sanitizeList returns [] → no recipient filter → all items
    expect(r.total).toBeGreaterThan(0);
  });

  test("A1: recipient with quote rejected", async () => {
    const r = await hit("/api/cross-team-queue?recipient=forge%22");
    expect(r.total).toBeGreaterThan(0);
  });

  test("valid recipient=forge filters to forge-only", async () => {
    const r = await hit("/api/cross-team-queue?recipient=forge");
    r.items.forEach((i) => expect(i.to).toBe("forge"));
  });

  test("team=software filters correctly", async () => {
    const r = await hit("/api/cross-team-queue?team=software");
    r.items.forEach((i) => expect(i.team).toBe("software"));
  });

  test("byRecipient grouping + per-bucket sort (oldest first)", async () => {
    const r = await hit("/api/cross-team-queue");
    for (const bucket of Object.values(r.byRecipient)) {
      for (let i = 1; i < bucket.length; i++) {
        expect(bucket[i - 1].ageHours).toBeGreaterThanOrEqual(bucket[i].ageHours);
      }
    }
  });

  test("stats.byTeam / byType / byRecipient populated", async () => {
    const r = await hit("/api/cross-team-queue");
    expect(Object.keys(r.stats.byTeam).length).toBeGreaterThan(0);
    expect(Object.keys(r.stats.byType).length).toBeGreaterThan(0);
    expect(Object.keys(r.stats.byRecipient).length).toBeGreaterThan(0);
    expect(r.stats.oldestAgeHours).toBeGreaterThanOrEqual(0);
  });

  test("errors[] surface malformed files; parseErrorCount matches length", async () => {
    const r = await hit("/api/cross-team-queue");
    expect(r.errors.length).toBe(r.parseErrorCount);
    expect(r.errors.length).toBeGreaterThanOrEqual(2); // missing-frontmatter + unclosed-yaml
  });

  test("no _scaffoldNote on Day 2 response", async () => {
    const r = await hit("/api/cross-team-queue") as any;
    expect(r._scaffoldNote).toBeUndefined();
  });

  test("limit=1 caps byRecipient bucket size", async () => {
    const r = await hit("/api/cross-team-queue?limit=1");
    for (const bucket of Object.values(r.byRecipient)) {
      expect(bucket.length).toBeLessThanOrEqual(1);
    }
  });
});

// ─── Day-4 probes (VELA peer review) ────────────────────────────────────

describe("Day 4 probes — VELA peer review 2026-04-18", () => {
  test("Probe 2a: action_required: review → actionRequired=true, hint=review", () => {
    const scan = scanCrossTeamQueue(FIXTURE_VAULT);
    const item = scan.items.find((i) => i.filename === "2026-04-18_action-review.md");
    expect(item).toBeDefined();
    expect(item!.actionRequired).toBe(true);
    expect(item!.actionHint).toBe("review");
  });

  test("Probe 2b: action_required: none → NOT mis-parsed as no prefix (word boundary)", () => {
    const scan = scanCrossTeamQueue(FIXTURE_VAULT);
    const item = scan.items.find((i) => i.filename === "2026-04-18_action-none.md");
    expect(item).toBeDefined();
    // With \b word-boundary fix: `none` doesn't match `no\b`, treated as unknown → true with hint
    expect(item!.actionRequired).toBe(true);
    expect(item!.actionHint).toBe("none");
  });

  test("Probe 3: `to: leo` in frontmatter overrides dir when leo ∈ TEAM_ROSTER.cross", () => {
    const scan = scanCrossTeamQueue(FIXTURE_VAULT);
    const item = scan.items.find((i) => i.filename === "2026-04-18_to-leo-cross.md");
    expect(item).toBeDefined();
    // File lives in david/inbox/ but addressed to leo → to=leo, team=cross
    expect(item!.to).toBe("leo");
    expect(item!.team).toBe("cross");
    // from still preserved
    expect(item!.from).toBe("david");
  });

  test("Probe 3 inverse: normal dir-wins still applies when `to:` matches dir or isn't cross-member", () => {
    const scan = scanCrossTeamQueue(FIXTURE_VAULT);
    const item = scan.items.find((i) => i.filename === "2026-04-17_normal-action-yes.md");
    // frontmatter `to: forge`, dir=forge, not cross → dir wins
    expect(item!.to).toBe("forge");
    expect(item!.team).toBe("software");
  });

  test("Probe 4: empty vault serializes all fields with empty typed values", () => {
    const emptyVault = join(import.meta.dir, "fixtures", "ctq", "empty-vault");
    const scan = scanCrossTeamQueue(emptyVault);
    expect(scan.items).toEqual([]);
    expect(scan.errors).toEqual([]);
    expect(scan.scannedFileCount).toBe(0);
    expect(scan.emptyInboxes).toEqual([]);
    expect(typeof scan.scannedAt).toBe("number");
  });
});
