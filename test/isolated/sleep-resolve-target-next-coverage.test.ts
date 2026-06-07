import { describe, expect, test } from "bun:test";

import { resolveSleepTarget, type ResolveDeps } from "../../src/vendor/mpr-plugins/sleep/resolve-target";

function deps(overrides: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    listSessions: async () => [
      { name: "01-alpha", windows: [{ name: "alpha-oracle" }] },
      { name: "02-beta", windows: [{ name: "beta-oracle" }] },
    ],
    loadFleet: () => [
      { name: "01-alpha", windows: [{ name: "alpha-main" }] },
    ],
    detectSession: async () => null,
    ...overrides,
  };
}

describe("sleep resolve target next coverage", () => {
  test("window-name tier matches case-insensitively and ignores trailing dashes", async () => {
    const result = await resolveSleepTarget(
      "WORKTREE",
      undefined,
      deps({
        listSessions: async () => [
          { name: "01-alpha", windows: [{ name: "worktree-" }] },
        ],
      }),
    );

    expect(result).toEqual({ session: "01-alpha", window: "worktree-" });
  });

  test("session-name tier uses explicit window override before fleet primary", async () => {
    const result = await resolveSleepTarget(
      "alpha",
      "override-window",
      deps(),
    );

    expect(result).toEqual({ session: "01-alpha", window: "override-window" });
  });

  test("detectSession result honors explicit window override before fleet/window fallback", async () => {
    const result = await resolveSleepTarget(
      "gamma",
      "custom-window",
      deps({ detectSession: async () => "01-alpha" }),
    );

    expect(result).toEqual({ session: "01-alpha", window: "custom-window" });
  });

  test("detectSession result uses fleet primary window when no override is present", async () => {
    const result = await resolveSleepTarget(
      "gamma",
      undefined,
      deps({ detectSession: async () => "01-alpha" }),
    );

    expect(result).toEqual({ session: "01-alpha", window: "alpha-main" });
  });

  test("detectSession result falls back to tmux first window without fleet entry", async () => {
    const result = await resolveSleepTarget(
      "gamma",
      undefined,
      deps({ detectSession: async () => "02-beta" }),
    );

    expect(result).toEqual({ session: "02-beta", window: "beta-oracle" });
  });

  test("returns null when detection finds a session without a fleet or tmux window", async () => {
    const result = await resolveSleepTarget(
      "gamma",
      undefined,
      deps({ detectSession: async () => "03-empty" }),
    );

    expect(result).toBeNull();
  });
});
