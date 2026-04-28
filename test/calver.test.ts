import { describe, it, expect } from "bun:test";
import {
  computeVersion,
  dateBase,
  maxAlphaFromTags,
  maxNFromPackageJson,
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
    expect(computeVersion({ stable: true, check: false, now: apr27_1200 }, tags)).toBe("26.4.27");
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
});
