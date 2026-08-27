import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

/**
 * Guard: src/cli.ts MUST stay the modular entry, never a committed build bundle.
 *
 * The `maw` bin runs src/cli.ts directly, so bun loads the modular source at
 * runtime and editing core files is live-effective. A previous local checkout
 * committed a minified `bun build` bundle here; it was carried into alpha and
 * silently froze every CORE change (fleet-ensure, wake-cmd, …) behind stale
 * inlined code. This test fails loudly if a bundle is ever committed as cli.ts
 * again. (dist/maw is the build output; src/cli.ts is the source entry.)
 */
describe("src/cli.ts is the modular entry, not a build bundle", () => {
  const cli = readFileSync("src/cli.ts", "utf8");

  test("has no bun-build bundle marker", () => {
    expect(cli.includes("// @bun")).toBe(false);
  });

  test("is small (a source entry, not thousands of minified lines)", () => {
    expect(cli.split("\n").length).toBeLessThan(200);
  });

  test("imports the modular CLI source it dispatches to", () => {
    expect(cli).toMatch(/from\s+["']\.\/cli\//);
    expect(cli).toContain("dispatchCommand");
  });
});
