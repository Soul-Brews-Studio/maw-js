/**
 * Direct import path test for src/lib/gh-user-orgs.ts.
 *
 * The behavioral coverage lives in test/wake-resolve-scan-suggest.test.ts,
 * which exercises fetchAllowedOrgs through the wake-suggest call path. This
 * file verifies the new shared module location can be consumed directly
 * (the bud plugin will import from here in Phase 2).
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  type AllowedOrgs,
  fetchAllowedOrgs,
  _resetAllowedOrgsCache,
} from "../src/lib/gh-user-orgs";

beforeEach(() => { _resetAllowedOrgsCache(); });

describe("src/lib/gh-user-orgs — direct import path", () => {
  test("fetchAllowedOrgs is callable via the new shared module", () => {
    const exec = (cmd: string) => {
      if (cmd.startsWith("gh api user --jq .login")) return "shared-user\n";
      if (cmd.startsWith("gh api user/orgs")) return "org-a\norg-b\n";
      throw new Error("unexpected cmd: " + cmd);
    };
    const result = fetchAllowedOrgs(exec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user).toBe("shared-user");
      expect(result.orgs.has("shared-user")).toBe(true);
      expect(result.orgs.has("org-a")).toBe(true);
      expect(result.orgs.has("org-b")).toBe(true);
    }
  });

  test("AllowedOrgs failure shape is preserved through the new module", () => {
    const exec = (_cmd: string) => { throw new Error("not authed"); };
    const result: AllowedOrgs = fetchAllowedOrgs(exec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("gh api user failed");
    }
  });

  test("re-export path through wake-resolve-scan-suggest still works", async () => {
    // Existing consumers (wake-resolve-impl, the wake-suggest test file)
    // import from wake-resolve-scan-suggest. Verify the re-export bridge.
    const reexported = await import("../src/commands/shared/wake-resolve-scan-suggest");
    expect(typeof reexported.fetchAllowedOrgs).toBe("function");
    expect(typeof reexported._resetAllowedOrgsCache).toBe("function");
  });
});
