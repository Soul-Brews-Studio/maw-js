import { describe, expect, test } from "bun:test";

import { analyzeChangedFiles } from "../../scripts/check-plugin-coverage-gate";

describe("plugin coverage gate (#2316)", () => {
  test("requires matching standalone test when a vendor plugin changes", () => {
    const result = analyzeChangedFiles(["src/vendor/mpr-plugins/costs/impl.ts"]);

    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("plugin-costs-standalone.test.ts");
  });

  test("accepts plugin changes when the matching standalone test changes too", () => {
    const result = analyzeChangedFiles([
      "src/vendor/mpr-plugins/costs/impl.ts",
      "test/isolated/plugin-costs-standalone.test.ts",
    ]);

    expect(result.ok).toBe(true);
  });

  test("requires SDK boundary changes to update a standalone test or helper", () => {
    const stale = analyzeChangedFiles(["src/sdk/index.ts"]);
    const covered = analyzeChangedFiles(["src/sdk/index.ts", "test/isolated/helpers/plugin-standalone-boundary.ts"]);

    expect(stale.ok).toBe(false);
    expect(stale.failures.join("\n")).toContain("SDK boundary changed");
    expect(covered.ok).toBe(true);
  });
});
