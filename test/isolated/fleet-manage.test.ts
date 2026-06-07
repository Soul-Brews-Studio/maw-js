/**
 * Regression coverage for #1486 — `maw fleet` must render every config entry
 * even when one fleet JSON is malformed or missing its `session.name` shape.
 */
import { describe, expect, test } from "bun:test";
import { renderFleetLs } from "../../src/commands/shared/fleet-manage";

describe("renderFleetLs", () => {
  test("#1486 — malformed entries render with fallback labels instead of crashing", () => {
    const output = renderFleetLs(
      [
        {
          file: "01-good.json",
          num: 1,
          groupName: "good",
          session: { name: "01-good", windows: [{ name: "main", repo: "org/good" }] },
        },
        {
          file: "02-missing-name.json",
          num: 2,
          groupName: "missing-name",
          session: { windows: [] },
        },
        {
          file: "03-null-session.json",
          num: 3,
          groupName: "null-session",
          session: null,
        },
        {
          file: "04-after-bad.json",
          num: 4,
          groupName: "after-bad",
          session: {
            name: "04-after-bad",
            windows: [
              { name: "main", repo: "org/after" },
              { name: "aux", repo: "org/after" },
            ],
          },
        },
      ] as any,
      1,
      ["01-good", "04-after-bad"],
    ).join("\n");

    expect(output).toContain("Fleet Configs");
    expect(output).toContain("(4 active, 1 disabled)");
    expect(output).toContain("01-good");
    expect(output).toContain("missing-name");
    expect(output).toContain("null-session");
    expect(output).toContain("04-after-bad");
    expect(output).toContain("INVALID");
    expect(output).toContain("running");
  });
});
