import { describe, it, expect } from "bun:test";
import {
  compareBases,
  computeVersion,
  dateBase,
  effectiveBase,
  extractBaseFromVersion,
  maxAlphaFromTags,
  maxNFromPackageJson,
  maxNFromTags,
} from "../scripts/calver";

describe("calver dateBase", () => {
  it("yy.m.d with no zero-pad (semver safety)", () => {
    expect(dateBase(new Date(2026, 3, 18, 9, 37))).toBe("26.4.18");
    expect(dateBase(new Date(2026, 1, 5, 9, 5))).toBe("26.2.5");
    expect(dateBase(new Date(2027, 0, 1, 0, 5))).toBe("27.1.1");
  });
});

describe("calver maxAlphaFromTags", () => {
  it("returns -1 when no matching tags", () => {
    expect(maxAlphaFromTags("26.4.18", [])).toBe(-1);
    expect(maxAlphaFromTags("26.4.18", ["v26.4.17-alpha.5", "v26.4.19-alpha.0"])).toBe(-1);
  });

  it("returns max N across matching alpha tags", () => {
    expect(
      maxAlphaFromTags("26.4.27", ["v26.4.27-alpha.11", "v26.4.27-alpha.12", "v26.4.27-alpha.13"])
    ).toBe(13);
  });

  it("handles non-monotonic tag order", () => {
    expect(
      maxAlphaFromTags("26.4.27", ["v26.4.27-alpha.13", "v26.4.27-alpha.0", "v26.4.27-alpha.7"])
    ).toBe(13);
  });

  it("ignores tags with non-integer suffixes (e.g. two-tier alpha.12.0)", () => {
    expect(
      maxAlphaFromTags("26.4.27", ["v26.4.27-alpha.5", "v26.4.27-alpha.12.0"])
    ).toBe(5);
  });

  it("handles single-digit and multi-digit N", () => {
    expect(maxAlphaFromTags("26.4.18", ["v26.4.18-alpha.0"])).toBe(0);
    expect(maxAlphaFromTags("26.4.18", ["v26.4.18-alpha.99"])).toBe(99);
  });
});

describe("calver computeVersion", () => {
  const apr18_0937 = new Date(2026, 3, 18, 9, 37);
  const apr27_1200 = new Date(2026, 3, 27, 12, 0);
  const jan1_0005  = new Date(2027, 0, 1, 0, 5);

  it("stable: yy.m.d (ignores tags)", () => {
    expect(computeVersion({ stable: true, check: false, now: apr18_0937 })).toBe("26.4.18");
    expect(computeVersion({ stable: true, check: false, now: jan1_0005 })).toBe("27.1.1");
  });

  it("alpha: starts at 0 when no tags exist for today", () => {
    expect(computeVersion({ stable: false, check: false, now: apr18_0937 }, [])).toBe("26.4.18-alpha.0");
    expect(computeVersion({ stable: false, check: false, now: jan1_0005 }, [])).toBe("27.1.1-alpha.0");
  });

  it("alpha: bumps to max+1 from existing today's tags", () => {
    const tags = ["v26.4.27-alpha.11", "v26.4.27-alpha.12"];
    expect(computeVersion({ stable: false, check: false, now: apr27_1200 }, tags)).toBe("26.4.27-alpha.13");
  });

  it("alpha: ignores tags from other dates", () => {
    const tags = ["v26.4.26-alpha.99", "v26.4.28-alpha.50"];
    expect(computeVersion({ stable: false, check: false, now: apr27_1200 }, tags)).toBe("26.4.27-alpha.0");
  });

  it("--stable ignores tags entirely", () => {
    const tags = ["v26.4.27-alpha.99"];
    expect(computeVersion({ stable: true, channel: "alpha", check: false, now: apr27_1200 }, tags)).toBe("26.4.27");
  });
});

describe("calver beta channel (#754)", () => {
  const apr28 = new Date(2026, 3, 28, 12, 0);

  it("maxNFromTags isolates alpha and beta counters", () => {
    const tags = [
      "v26.4.28-alpha.0",
      "v26.4.28-alpha.1",
      "v26.4.28-beta.0",
    ];
    expect(maxNFromTags("26.4.28", "alpha", tags)).toBe(1);
    expect(maxNFromTags("26.4.28", "beta", tags)).toBe(0);
  });

  it("maxAlphaFromTags is a back-compat alias for alpha channel", () => {
    const tags = ["v26.4.28-alpha.5", "v26.4.28-beta.99"];
    expect(maxAlphaFromTags("26.4.28", tags)).toBe(5);
  });

  it("--beta computes next beta version with independent counter", () => {
    const tags = ["v26.4.28-alpha.21", "v26.4.28-beta.2"];
    expect(
      computeVersion({ stable: false, channel: "beta", check: false, now: apr28 }, tags)
    ).toBe("26.4.28-beta.3");
  });

  it("--beta starts at 0 when no beta tags exist for today", () => {
    const tags = ["v26.4.28-alpha.50"];
    expect(
      computeVersion({ stable: false, channel: "beta", check: false, now: apr28 }, tags)
    ).toBe("26.4.28-beta.0");
  });

  it("alpha and beta on the same day do not collide", () => {
    const tags = ["v26.4.28-alpha.5"];
    const alpha = computeVersion({ stable: false, channel: "alpha", check: false, now: apr28 }, tags);
    const beta = computeVersion({ stable: false, channel: "beta", check: false, now: apr28 }, tags);
    expect(alpha).toBe("26.4.28-alpha.6");
    expect(beta).toBe("26.4.28-beta.0");
  });

  it("beta tag walk rejects two-tier suffixes (e.g. beta.12.0)", () => {
    const tags = ["v26.4.28-beta.5", "v26.4.28-beta.12.0"];
    expect(maxNFromTags("26.4.28", "beta", tags)).toBe(5);
  });
});

describe("calver maxNFromPackageJson (#784)", () => {
  it("returns N for matching alpha base+channel", () => {
    expect(maxNFromPackageJson("26.4.28", "alpha", "26.4.28-alpha.24")).toBe(24);
    expect(maxNFromPackageJson("26.4.28", "alpha", "v26.4.28-alpha.7")).toBe(7);
  });

  it("returns N for matching beta base+channel", () => {
    expect(maxNFromPackageJson("26.4.28", "beta", "26.4.28-beta.3")).toBe(3);
  });

  it("returns -1 when date base does not match", () => {
    expect(maxNFromPackageJson("26.4.28", "alpha", "26.4.27-alpha.99")).toBe(-1);
    expect(maxNFromPackageJson("26.4.28", "alpha", "26.5.1-alpha.0")).toBe(-1);
  });

  it("returns -1 when channel does not match", () => {
    expect(maxNFromPackageJson("26.4.28", "alpha", "26.4.28-beta.5")).toBe(-1);
    expect(maxNFromPackageJson("26.4.28", "beta", "26.4.28-alpha.5")).toBe(-1);
  });

  it("rejects non-integer suffix (e.g. two-tier alpha.12.0 or alpha.12-rc)", () => {
    expect(maxNFromPackageJson("26.4.28", "alpha", "26.4.28-alpha.12.0")).toBe(-1);
    expect(maxNFromPackageJson("26.4.28", "alpha", "26.4.28-alpha.12-rc")).toBe(-1);
    expect(maxNFromPackageJson("26.4.28", "alpha", "26.4.28-alpha.abc")).toBe(-1);
  });

  it("returns -1 for empty or stable-only version strings", () => {
    expect(maxNFromPackageJson("26.4.28", "alpha", "")).toBe(-1);
    expect(maxNFromPackageJson("26.4.28", "alpha", "26.4.28")).toBe(-1);
  });
});

describe("calver computeVersion package.json walk (#784)", () => {
  const apr28_1200 = new Date(2026, 3, 28, 12, 0);

  it("package.json ahead of tags wins (alpha-branch case from #784)", () => {
    // Simulates current bug: no tags exist yet for today (alpha branch),
    // but package.json carries 26.4.28-alpha.24 from prior in-flight alphas.
    expect(
      computeVersion({ stable: false, check: false, now: apr28_1200 }, [], "26.4.28-alpha.24"),
    ).toBe("26.4.28-alpha.25");
  });

  it("tags ahead of package.json wins", () => {
    const tags = ["v26.4.28-alpha.30"];
    expect(
      computeVersion({ stable: false, check: false, now: apr28_1200 }, tags, "26.4.28-alpha.10"),
    ).toBe("26.4.28-alpha.31");
  });

  it("tags and package.json at same value still increments by 1", () => {
    const tags = ["v26.4.28-alpha.5"];
    expect(
      computeVersion({ stable: false, check: false, now: apr28_1200 }, tags, "26.4.28-alpha.5"),
    ).toBe("26.4.28-alpha.6");
  });

  it("daily rollover: yesterday's package.json + no today-tags → .0", () => {
    // Critical: without date-gating, every day would start at yesterday's N+1
    // instead of resetting to 0. Verifies date-mismatch returns -1 from pkg-walk.
    expect(
      computeVersion({ stable: false, check: false, now: apr28_1200 }, [], "26.4.27-alpha.50"),
    ).toBe("26.4.28-alpha.0");
  });

  it("yesterday's stable in package.json + today's no-tags → .0", () => {
    // After a stable cut, package.json holds bare YY.M.D. Next-day alpha
    // starts at .0, not at the stable's "version".
    expect(
      computeVersion({ stable: false, check: false, now: apr28_1200 }, [], "26.4.27"),
    ).toBe("26.4.28-alpha.0");
  });
});

describe("calver maxNFromPackageJson — robustness (#784 explorer findings)", () => {
  it("rejects non-CalVer legacy version (e.g. 2.0.0-alpha.134)", () => {
    // Pre-CalVer migration shape — the trailing 134 must NOT match.
    expect(maxNFromPackageJson("26.4.28", "alpha", "2.0.0-alpha.134")).toBe(-1);
  });

  it("substring trap: base 26.4.2 must not match 26.4.28-alpha.N", () => {
    // The dash boundary in `${base}-${channel}.` should anchor the match
    // so a shorter base doesn't fall through into a longer date.
    expect(maxNFromPackageJson("26.4.2", "alpha", "26.4.28-alpha.5")).toBe(-1);
    expect(maxNFromPackageJson("26.4.2", "alpha", "26.4.20-alpha.5")).toBe(-1);
    // Genuine match still works for the actual base 26.4.2:
    expect(maxNFromPackageJson("26.4.2", "alpha", "26.4.2-alpha.5")).toBe(5);
  });

  it("rejects malformed alpha suffix in package.json", () => {
    expect(maxNFromPackageJson("26.4.28", "alpha", "26.4.28-alpha.")).toBe(-1);
    expect(maxNFromPackageJson("26.4.28", "alpha", "26.4.28-alpha")).toBe(-1);
    expect(maxNFromPackageJson("26.4.28", "alpha", "26.4.28-alpha.bogus")).toBe(-1);
    expect(maxNFromPackageJson("26.4.28", "alpha", "26.4.28-alpha.12b")).toBe(-1);
  });

  it("zero-padded N parses as decimal (parity with parseInt)", () => {
    // Mirrors maxNFromTags's parseInt behavior — `05` → 5, not octal.
    expect(maxNFromPackageJson("26.4.28", "alpha", "26.4.28-alpha.05")).toBe(5);
  });

  it("rejects rc/other channels even if structurally similar", () => {
    expect(maxNFromPackageJson("26.4.28", "alpha", "26.4.28-rc.5")).toBe(-1);
  });
});

describe("calver extractBaseFromVersion (#819)", () => {
  it("strips alpha/beta suffix, returns YY.M.D", () => {
    expect(extractBaseFromVersion("26.4.29-alpha.5")).toBe("26.4.29");
    expect(extractBaseFromVersion("26.4.29-beta.0")).toBe("26.4.29");
  });

  it("accepts bare YY.M.D (post-stable-cut shape)", () => {
    expect(extractBaseFromVersion("26.4.29")).toBe("26.4.29");
    expect(extractBaseFromVersion("v26.4.29")).toBe("26.4.29");
  });

  it("accepts leading v prefix", () => {
    expect(extractBaseFromVersion("v26.4.29-alpha.5")).toBe("26.4.29");
  });

  it("returns null for empty/missing", () => {
    expect(extractBaseFromVersion("")).toBeNull();
  });

  it("returns null for non-CalVer legacy versions", () => {
    expect(extractBaseFromVersion("2.0.0-alpha.134")).toBe("2.0.0"); // shape-OK
    expect(extractBaseFromVersion("not-a-version")).toBeNull();
    expect(extractBaseFromVersion("26.4")).toBeNull();
    expect(extractBaseFromVersion("26.4.29.1")).toBeNull();
  });
});

describe("calver compareBases (#819)", () => {
  it("compares by integer segment, not lexicographic", () => {
    // Lexicographic would say "26.4.30" < "26.4.4" — must compare ints.
    expect(compareBases("26.4.30", "26.4.4")).toBeGreaterThan(0);
    expect(compareBases("26.4.4", "26.4.30")).toBeLessThan(0);
  });

  it("equal bases return 0", () => {
    expect(compareBases("26.4.28", "26.4.28")).toBe(0);
  });

  it("year and month dominate", () => {
    expect(compareBases("27.1.1", "26.12.31")).toBeGreaterThan(0);
    expect(compareBases("26.5.1", "26.4.99")).toBeGreaterThan(0);
  });

  it("throws on malformed input", () => {
    expect(() => compareBases("26.4", "26.4.28")).toThrow();
    expect(() => compareBases("26.4.28.1", "26.4.28")).toThrow();
  });
});

describe("calver effectiveBase (#819)", () => {
  it("picks package.json base when ahead of today", () => {
    expect(effectiveBase("26.4.28", "26.4.29-alpha.5")).toBe("26.4.29");
  });

  it("picks today when package.json is behind", () => {
    expect(effectiveBase("26.4.28", "26.4.27-alpha.99")).toBe("26.4.28");
  });

  it("picks today when bases are equal", () => {
    expect(effectiveBase("26.4.28", "26.4.28-alpha.18")).toBe("26.4.28");
  });

  it("picks today when package.json is empty/unparseable", () => {
    expect(effectiveBase("26.4.28", "")).toBe("26.4.28");
    expect(effectiveBase("26.4.28", "not-a-version")).toBe("26.4.28");
  });

  it("handles bare future stable (post-cut shape, no suffix)", () => {
    // Just-cut tomorrow's stable: package.json holds bare 26.4.30 with no suffix.
    expect(effectiveBase("26.4.28", "26.4.30")).toBe("26.4.30");
  });
});

describe("calver computeVersion future-dated package.json (#819)", () => {
  const apr28_1200 = new Date(2026, 3, 28, 12, 0);
  const apr29_0500 = new Date(2026, 3, 29, 5, 0);

  it("future-dated alpha: continues counter on package.json's date (NOT downgrade)", () => {
    // The exact bug from #819: package.json at 26.4.29-alpha.5, clock at
    // 2026-04-28. Pre-fix this returned 26.4.28-alpha.0 (a downgrade).
    expect(
      computeVersion({ stable: false, check: false, now: apr28_1200 }, [], "26.4.29-alpha.5"),
    ).toBe("26.4.29-alpha.6");
  });

  it("today-dated alpha: existing tag-walk behavior preserved", () => {
    expect(
      computeVersion({ stable: false, check: false, now: apr28_1200 }, [], "26.4.28-alpha.18"),
    ).toBe("26.4.28-alpha.19");
  });

  it("date roll: clock advances past package.json → resets to .0", () => {
    // Clock is 26.4.29, package.json still at 26.4.28-alpha.18 → .0 fresh day.
    expect(
      computeVersion({ stable: false, check: false, now: apr29_0500 }, [], "26.4.28-alpha.18"),
    ).toBe("26.4.29-alpha.0");
  });

  it("just-cut stable in package.json: bare YY.M.D → alpha.0 on that date", () => {
    // After --stable cut, package.json holds bare 26.4.30. Today's clock still
    // 26.4.28 — must NOT regress to 26.4.28-alpha.0; bumps the future date.
    expect(
      computeVersion({ stable: false, check: false, now: apr28_1200 }, [], "26.4.30"),
    ).toBe("26.4.30-alpha.0");
  });

  it("future-dated + tags for that future date: tags also count", () => {
    // If the stable-cut day already saw alphas before the cut tagged some,
    // and package.json holds 26.4.29-alpha.3 plus tags up to alpha.7 exist
    // for 26.4.29 — bump to alpha.8.
    const tags = ["v26.4.29-alpha.7"];
    expect(
      computeVersion({ stable: false, check: false, now: apr28_1200 }, tags, "26.4.29-alpha.3"),
    ).toBe("26.4.29-alpha.8");
  });

  it("--stable always uses today's clock, never package.json's future date", () => {
    // Defensive: if package.json is somehow ahead, --stable still cuts today.
    expect(
      computeVersion({ stable: true, check: false, now: apr28_1200 }, [], "26.4.29-alpha.5"),
    ).toBe("26.4.28");
  });
});
