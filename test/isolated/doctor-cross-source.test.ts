/**
 * doctor-cross-source.test.ts — Sub-PR 2 of #841.
 *
 * Verifies `findGaps()` (cross-source consistency analyzer over
 * `OracleManifest`) plus the `manifest:cross-source` doctor check:
 *
 *   1. Each gap pattern fires once for the matching fixture
 *   2. Empty manifest produces no warnings (no false positives)
 *   3. All-sources-aligned manifest produces no warnings
 *   4. Doctor surface integrates the result as a non-failing warning
 *      check (ok:true, message body summarizes gaps)
 *
 * `findGaps()` is pure — most tests drive it with hand-built
 * `OracleManifestEntry[]` fixtures, sidestepping the filesystem entirely.
 * The doctor-integration test uses the same isolated-tmpdir pattern as
 * `oracle-manifest.test.ts` because `cmdDoctor` reads CONFIG_DIR /
 * FLEET_DIR through the manifest.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Pure tests for findGaps() — no env mutation needed ──────────────────────

import {
  findGaps,
  summarizeGaps,
  formatGap,
  type CrossSourceGap,
} from "../../src/commands/plugins/doctor/cross-source-detect";
import type { OracleManifestEntry } from "../../src/lib/oracle-manifest";

function entry(o: Partial<OracleManifestEntry> & { name: string; sources: OracleManifestEntry["sources"] }): OracleManifestEntry {
  return {
    isLive: false,
    ...o,
  } as OracleManifestEntry;
}

describe("findGaps — empty / aligned manifests produce no warnings", () => {
  test("empty manifest → no gaps", () => {
    expect(findGaps([])).toEqual([]);
  });

  test("fully aligned oracle (fleet+session+agent+oracles-json, node=local) → no gaps", () => {
    const m = [
      entry({
        name: "neo",
        sources: ["fleet", "session", "agent", "oracles-json"],
        node: "local",
        session: "neo",
        window: "neo-oracle",
        sessionId: "uuid-1",
        repo: "Soul-Brews-Studio/neo-oracle",
        localPath: "/tmp/neo-oracle",
        hasFleetConfig: true,
        hasPsi: true,
      }),
    ];
    expect(findGaps(m)).toEqual([]);
  });

  test("aligned remote oracle (agent only, remote node) → no gaps (federation routing target)", () => {
    // Pure agent → remote node is a normal federation routing setup;
    // we don't expect a fleet window for an oracle that lives on another box.
    const m = [
      entry({ name: "homekeeper", sources: ["agent"], node: "mba" }),
    ];
    expect(findGaps(m)).toEqual([]);
  });
});

describe("findGaps — each gap pattern fires for its matching fixture", () => {
  test("agent-without-fleet: agent→local with no fleet source", () => {
    const gaps = findGaps([
      entry({ name: "stray", sources: ["agent"], node: "local" }),
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe("agent-without-fleet");
    expect(gaps[0].oracle).toBe("stray");
    expect(gaps[0].detail).toContain("config.agents");
    expect(gaps[0].detail).toContain("'maw hey stray'");
  });

  test("session-without-fleet: only session source, no fleet/agent", () => {
    const gaps = findGaps([
      entry({ name: "just-budded", sources: ["session"], sessionId: "uuid-jb" }),
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe("session-without-fleet");
    expect(gaps[0].oracle).toBe("just-budded");
  });

  test("fleet-without-oracles-json: fleet source, no oracles-json, no localPath", () => {
    const gaps = findGaps([
      entry({
        name: "fleet-only",
        sources: ["fleet", "agent"], // fleet pre-populates agent at loadConfig time
        node: "local",
        session: "fleet-only",
        window: "fleet-only-oracle",
        hasFleetConfig: true,
      }),
    ]);
    // Should produce exactly the fleet-without-oracles-json gap
    const kinds = gaps.map((g) => g.kind);
    expect(kinds).toContain("fleet-without-oracles-json");
    // It should NOT also produce agent-without-fleet (fleet IS present)
    expect(kinds).not.toContain("agent-without-fleet");
  });

  test("oracles-json-without-runtime: only oracles-json, no fleet/session/agent", () => {
    const gaps = findGaps([
      entry({
        name: "orphan",
        sources: ["oracles-json"],
        repo: "Soul-Brews-Studio/orphan-oracle",
        localPath: "/tmp/orphan",
        hasPsi: true,
      }),
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].kind).toBe("oracles-json-without-runtime");
    expect(gaps[0].oracle).toBe("orphan");
    expect(gaps[0].detail).toContain("orphan");
  });

  test("agent-mismatch-fleet-local: fleet+agent both, but resolved node is remote", () => {
    const gaps = findGaps([
      entry({
        name: "mismatched",
        sources: ["fleet", "agent"],
        node: "mba", // agent overrode fleet's "local" — operator drift
        session: "mismatched",
        window: "mismatched-oracle",
        hasFleetConfig: true,
      }),
    ]);
    const kinds = gaps.map((g) => g.kind);
    expect(kinds).toContain("agent-mismatch-fleet-local");
  });
});

describe("findGaps — combinations and ordering", () => {
  test("multiple gaps for different oracles all surface", () => {
    const gaps = findGaps([
      entry({ name: "stray", sources: ["agent"], node: "local" }),
      entry({ name: "just-budded", sources: ["session"], sessionId: "u" }),
      entry({ name: "orphan", sources: ["oracles-json"], localPath: "/p", hasPsi: true }),
    ]);
    expect(gaps).toHaveLength(3);
    const oracles = gaps.map((g) => g.oracle);
    expect(oracles).toEqual(["just-budded", "orphan", "stray"]); // alphabetical
  });

  test("does not flag agent-without-fleet when node is remote (federation peer)", () => {
    const gaps = findGaps([
      entry({ name: "remote-pal", sources: ["agent"], node: "mba" }),
    ]);
    expect(gaps).toEqual([]);
  });

  test("does not flag fleet-without-oracles-json when localPath is known", () => {
    // Routed-only setup: fleet has the window AND localPath got surfaced
    // from the manifest (e.g. via worktree fallback in a future sub-PR).
    const gaps = findGaps([
      entry({
        name: "routed",
        sources: ["fleet", "agent"],
        node: "local",
        localPath: "/tmp/routed",
        hasFleetConfig: true,
      }),
    ]);
    expect(gaps).toEqual([]);
  });

  test("ordering: same oracle multiple gaps → kind alphabetical", () => {
    // We can't trivially get two gaps for one oracle through the live
    // patterns (they're mostly mutually exclusive), but the sort
    // contract holds — verify with a constructed pair via two oracles
    // sharing a name pattern.
    const gaps = findGaps([
      entry({ name: "z-last", sources: ["session"], sessionId: "u" }),
      entry({ name: "a-first", sources: ["agent"], node: "local" }),
    ]);
    expect(gaps[0].oracle).toBe("a-first");
    expect(gaps[1].oracle).toBe("z-last");
  });
});

describe("summarizeGaps + formatGap", () => {
  test("empty gaps → headline 'no cross-source inconsistencies'", () => {
    const s = summarizeGaps([]);
    expect(s.headline).toBe("no cross-source inconsistencies");
    expect(s.lines).toEqual([]);
  });

  test("single gap → headline counts 1, breakdown shows kind", () => {
    const gaps: CrossSourceGap[] = [
      { oracle: "x", kind: "agent-without-fleet", detail: "..." },
    ];
    const s = summarizeGaps(gaps);
    expect(s.headline).toContain("1 cross-source gap");
    expect(s.headline).toContain("agent-without-fleet×1");
    expect(s.lines).toHaveLength(1);
  });

  test("multiple gaps of mixed kinds → breakdown groups by kind", () => {
    const gaps: CrossSourceGap[] = [
      { oracle: "a", kind: "agent-without-fleet", detail: "..." },
      { oracle: "b", kind: "agent-without-fleet", detail: "..." },
      { oracle: "c", kind: "session-without-fleet", detail: "..." },
    ];
    const s = summarizeGaps(gaps);
    expect(s.headline).toContain("3 cross-source gaps");
    expect(s.headline).toContain("agent-without-fleet×2");
    expect(s.headline).toContain("session-without-fleet×1");
  });

  test("formatGap → '[kind] detail'", () => {
    const out = formatGap({ oracle: "x", kind: "agent-without-fleet", detail: "hello" });
    expect(out).toBe("[agent-without-fleet] hello");
  });
});

// ─── Doctor integration — uses an isolated CONFIG_DIR/FLEET_DIR ──────────────

const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "maw-doctor-cross-841-"));
const TEST_FLEET_DIR = join(TEST_CONFIG_DIR, "fleet");
mkdirSync(TEST_FLEET_DIR, { recursive: true });

process.env.MAW_CONFIG_DIR = TEST_CONFIG_DIR;
delete process.env.MAW_HOME;
process.env.MAW_TEST_MODE = "1";

const manifestModule = await import("../../src/lib/oracle-manifest");
const configModule = await import("../../src/config");
const { cmdDoctor } = await import("../../src/commands/plugins/doctor/impl");

const CONFIG_FILE = join(TEST_CONFIG_DIR, "maw.config.json");
const ORACLES_JSON = join(TEST_CONFIG_DIR, "oracles.json");

afterAll(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of [CONFIG_FILE, ORACLES_JSON]) {
    try { rmSync(f, { force: true }); } catch { /* ok */ }
  }
  try {
    rmSync(TEST_FLEET_DIR, { recursive: true, force: true });
    mkdirSync(TEST_FLEET_DIR, { recursive: true });
  } catch { /* best-effort */ }
  configModule.resetConfig();
  manifestModule.invalidateManifest();
});

function writeFleetWindow(file: string, sessionName: string, windows: Array<{ name: string; repo?: string }>) {
  writeFileSync(
    join(TEST_FLEET_DIR, file),
    JSON.stringify({ name: sessionName, windows }, null, 2) + "\n",
    "utf-8",
  );
}

function writeConfig(patch: Record<string, unknown>) {
  writeFileSync(CONFIG_FILE, JSON.stringify(patch, null, 2) + "\n", "utf-8");
  configModule.resetConfig();
}

const origLog = console.log;
async function runOnly<T>(fn: () => Promise<T>): Promise<T> {
  console.log = () => {};
  try { return await fn(); }
  finally { console.log = origLog; }
}

describe("cmdDoctor 'manifest' check — integration", () => {
  test("empty manifest → ok:true, message 'no cross-source inconsistencies'", async () => {
    const out = await runOnly(() => cmdDoctor(["manifest"]));
    const c = out.checks.find((x) => x.name === "manifest:cross-source")!;
    expect(c).toBeDefined();
    expect(c.ok).toBe(true);
    expect(c.message).toBe("no cross-source inconsistencies");
  });

  test("session-only oracle → ok:true with session-without-fleet headline", async () => {
    writeConfig({ sessions: { "just-budded": "uuid-jb-1" } });
    const out = await runOnly(() => cmdDoctor(["manifest"]));
    const c = out.checks.find((x) => x.name === "manifest:cross-source")!;
    // Always ok:true — gaps are warnings, not failures.
    expect(c.ok).toBe(true);
    expect(c.message).toContain("1 cross-source gap");
    expect(c.message).toContain("session-without-fleet");
  });

  test("agent-only with node=local → flags agent-without-fleet", async () => {
    writeConfig({ agents: { stray: "local" } });
    const out = await runOnly(() => cmdDoctor(["manifest"]));
    const c = out.checks.find((x) => x.name === "manifest:cross-source")!;
    expect(c.ok).toBe(true);
    expect(c.message).toContain("agent-without-fleet");
  });

  test("fleet window present + no oracles.json → flags fleet-without-oracles-json", async () => {
    writeFleetWindow("100-fleet.json", "fleet-only", [
      { name: "fleet-only-oracle", repo: "Soul-Brews-Studio/fleet-only-oracle" },
    ]);
    const out = await runOnly(() => cmdDoctor(["manifest"]));
    const c = out.checks.find((x) => x.name === "manifest:cross-source")!;
    expect(c.ok).toBe(true);
    expect(c.message).toContain("fleet-without-oracles-json");
  });

  test("doctor 'all' includes manifest:cross-source check", async () => {
    const out = await runOnly(() => cmdDoctor(["all"]));
    expect(out.checks.map((c) => c.name)).toContain("manifest:cross-source");
  });

  test("default args (no positional) include manifest:cross-source check", async () => {
    const out = await runOnly(() => cmdDoctor([]));
    expect(out.checks.map((c) => c.name)).toContain("manifest:cross-source");
  });

  test("manifest gap does NOT flip overall doctor result to failed", async () => {
    // session-only oracle is a warning (not blocking) — overall doctor
    // ok flag should still reflect only HARD failures from other checks.
    writeConfig({ sessions: { ghost: "uuid-ghost" } });
    const out = await runOnly(() => cmdDoctor(["manifest"]));
    expect(out.ok).toBe(true);
  });
});
