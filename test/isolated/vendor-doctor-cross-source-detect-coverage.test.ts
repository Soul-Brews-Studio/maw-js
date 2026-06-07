/** Focused isolated coverage for doctor/cross-source-detect.ts gap predicates. */
import { describe, expect, test } from "bun:test";
import type { OracleManifestEntry } from "maw-js/lib/oracle-manifest";
import {
  findGaps,
  formatGap,
  summarizeGaps,
} from "../../src/vendor/mpr-plugins/doctor/cross-source-detect.ts";

function entry(partial: OracleManifestEntry): OracleManifestEntry {
  return partial;
}

describe("doctor cross-source gap detection", () => {
  test("detects each supported cross-source gap and keeps deterministic ordering", () => {
    const gaps = findGaps([
      entry({ name: "zeta", sources: ["agent"], node: "local" }),
      entry({ name: "beta", sources: ["session"], sessionId: "s-1" }),
      entry({ name: "gamma", sources: ["fleet"], session: "work", window: "gamma-oracle" }),
      entry({ name: "alpha", sources: ["oracles-json"], localPath: "/repo/alpha" }),
      entry({ name: "delta", sources: ["fleet", "agent"], node: "remote-node", localPath: "/repo/delta" }),
    ]);

    expect(gaps.map(g => [g.oracle, g.kind])).toEqual([
      ["alpha", "oracles-json-without-runtime"],
      ["beta", "session-without-fleet"],
      ["delta", "agent-mismatch-fleet-local"],
      ["gamma", "fleet-without-oracles-json"],
      ["zeta", "agent-without-fleet"],
    ]);
    expect(gaps.map(formatGap)).toEqual([
      expect.stringContaining("[oracles-json-without-runtime] oracles.json lists 'alpha'"),
      expect.stringContaining("[session-without-fleet] config.sessions has 'beta'"),
      expect.stringContaining("[agent-mismatch-fleet-local] fleet window for 'delta' is local"),
      expect.stringContaining("[fleet-without-oracles-json] fleet has 'gamma'"),
      expect.stringContaining("[agent-without-fleet] config.agents has 'zeta'"),
    ]);

    expect(summarizeGaps(gaps)).toEqual({
      headline:
        "5 cross-source gaps (agent-mismatch-fleet-local×1, agent-without-fleet×1, fleet-without-oracles-json×1, oracles-json-without-runtime×1, session-without-fleet×1)",
      lines: gaps.map(formatGap),
    });
  });

  test("does not flag legitimate partial-routing states", () => {
    expect(findGaps([
      entry({ name: "remote", sources: ["agent"], node: "mba" }),
      entry({ name: "session-routed", sources: ["session", "agent"], node: "mba" }),
      entry({ name: "fleet-cached", sources: ["fleet", "oracles-json"], localPath: "/repo/fleet-cached" }),
      entry({ name: "fleet-path", sources: ["fleet"], localPath: "/repo/fleet-path" }),
      entry({ name: "local-aligned", sources: ["fleet", "agent"], node: "local", localPath: "/repo/local-aligned" }),
    ])).toEqual([]);

    expect(summarizeGaps([])).toEqual({
      headline: "no cross-source inconsistencies",
      lines: [],
    });
  });

  test("summarizes a singular gap with singular wording", () => {
    const [gap] = findGaps([entry({ name: "solo", sources: ["agent"], node: "local" })]);

    expect(summarizeGaps([gap])).toEqual({
      headline: "1 cross-source gap (agent-without-fleet×1)",
      lines: [formatGap(gap)],
    });
  });
});
