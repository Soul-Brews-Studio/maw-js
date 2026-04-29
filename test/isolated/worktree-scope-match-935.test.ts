/**
 * Regression test for #935 — fleet-doctor worktree-to-window matching is
 * GLOBAL across all sessions, producing phantom ambiguity when multiple
 * oracles share a generic worktree name (e.g. `1--no-attach`).
 *
 * Pre-fix: `resolveWorktreeTarget(taskPart, allWindows)` searched every
 * window across every session. With 4 oracles each owning a `--no-attach`
 * window, Tier 2a suffix-match returned 4 candidates → "ambiguous" → all 4
 * worktrees left unbound (status: stale).
 *
 * Post-fix: scoped search hits the PARENT oracle's session FIRST. Each
 * worktree binds to its own session window with no cross-session collision.
 * Global fall-through is preserved when the parent session is missing
 * (e.g. the oracle hasn't booted yet) so existing single-oracle behavior
 * is unchanged.
 *
 * Test cases:
 *   1. 4 oracles each with a `1--no-attach` worktree → each binds locally,
 *      no ambiguous-match noise.
 *   2. Parent session missing → falls through to global (existing behavior
 *      preserved; single matching window resolves cleanly).
 *   3. Single oracle case unchanged (regression guard for #823 dedupe).
 *   4. Fleet-numeric session name (`NN-<oracle>`) — parent matched via
 *      `endsWith(`-<oracle>`)` selector.
 *   5. Parent session exists but window is in a DIFFERENT session
 *      (orphaned window) → still falls through to global.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { join } from "path";

const root = join(import.meta.dir, "../../src");

// Mutable stubs so each test can reshape the world
let stubFindOutput: string = "";
let stubSessions: Array<{ name: string; windows: Array<{ name: string; index: number; active: boolean }> }> = [];

mock.module(join(root, "core/transport/ssh"), () => ({
  hostExec: async (cmd: string) => {
    if (cmd.includes("find ") && cmd.includes(".wt-")) {
      return stubFindOutput;
    }
    if (cmd.includes("rev-parse --abbrev-ref")) {
      return "agents/935-test";
    }
    // Suppress prunable-worktree probe — return empty so no orphans appear
    return "";
  },
  listSessions: async () => stubSessions,
}));

mock.module(join(root, "config/ghq-root"), () => ({
  getGhqRoot: () => "/ghq",
}));

mock.module(join(root, "core/paths"), () => ({
  FLEET_DIR: "/tmp/maw-test-nonexistent-fleet-935",
}));

const { scanWorktrees } = await import(join(root, "core/fleet/worktrees-scan"));

// Helpers
const wtPath = (org: string, oracle: string, wt: string) =>
  `/ghq/github.com/${org}/${oracle}/${oracle}.wt-${wt}`;
const win = (name: string, index = 1) => ({ name, index, active: false });

beforeEach(() => {
  stubFindOutput = "";
  stubSessions = [];
});

describe("scanWorktrees (#935) — scope window match to parent oracle session", () => {
  it("4 oracles with same `1--no-attach` worktree each bind locally (no ambiguous match)", async () => {
    // Four oracles each owning a `--no-attach` worktree, each living in its
    // own session with a `<name>--no-attach` window.
    stubFindOutput = [
      wtPath("Soul-Brews-Studio", "pulse-oracle",        "1--no-attach"),
      wtPath("Soul-Brews-Studio", "timekeeper-oracle",   "1--no-attach"),
      wtPath("Soul-Brews-Studio", "m5-wormhole-oracle",  "1--no-attach"),
      wtPath("Soul-Brews-Studio", "white-wormhole-oracle","1--no-attach"),
    ].join("\n");

    stubSessions = [
      { name: "pulse",          windows: [win("pulse--no-attach")] },
      { name: "timekeeper",     windows: [win("timekeeper--no-attach")] },
      { name: "m5-wormhole",    windows: [win("m5-wormhole--no-attach")] },
      { name: "white-wormhole", windows: [win("white-wormhole--no-attach")] },
    ];

    const errLogs: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => { errLogs.push(a.map(String).join(" ")); };

    try {
      const results = await scanWorktrees();
      // All 4 should resolve to ACTIVE bound to the right window.
      const expectations: Array<[string, string]> = [
        ["pulse-oracle",         "pulse--no-attach"],
        ["timekeeper-oracle",    "timekeeper--no-attach"],
        ["m5-wormhole-oracle",   "m5-wormhole--no-attach"],
        ["white-wormhole-oracle","white-wormhole--no-attach"],
      ];
      for (const [oracle, expectedWindow] of expectations) {
        const wt = results.find(r => r.path.includes(`/${oracle}/`));
        expect(wt, `worktree under ${oracle}/ should be present`).toBeDefined();
        expect(wt!.status).toBe("active");
        expect(wt!.tmuxWindow).toBe(expectedWindow);
      }

      // No ambiguous-match noise — pre-fix path emitted 4 such errors.
      const combined = errLogs.join("\n");
      expect(combined).not.toContain("ambiguous");
    } finally {
      console.error = origErr;
    }
  });

  it("parent session missing → falls through to global (existing behavior preserved)", async () => {
    // Worktree under `lone-oracle` but the only running session is `other`,
    // which happens to host a window matching the worktree's task part.
    // Pre-fix: global resolved cleanly (one match) → bound. Post-fix: scoped
    // search finds no parent session → falls through to global → still binds.
    stubFindOutput = wtPath("Org", "lone-oracle", "1-feature");
    stubSessions = [
      { name: "other", windows: [win("feature")] },
    ];

    const errLogs: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => { errLogs.push(a.map(String).join(" ")); };

    try {
      const results = await scanWorktrees();
      const wt = results.find(r => r.name === "1-feature");
      expect(wt).toBeDefined();
      // Global fall-through resolves cleanly (single match) → active.
      expect(wt!.status).toBe("active");
      expect(wt!.tmuxWindow).toBe("feature");
      expect(errLogs.join("\n")).not.toContain("ambiguous");
    } finally {
      console.error = origErr;
    }
  });

  it("single oracle case unchanged — bare suffix match to its own window", async () => {
    // Regression guard: the original neo case from #823 still works.
    stubFindOutput = wtPath("Org", "neo-oracle", "1-freelance");
    stubSessions = [
      { name: "neo", windows: [win("neo-freelance")] },
    ];

    const results = await scanWorktrees();
    const wt = results.find(r => r.name === "1-freelance");
    expect(wt).toBeDefined();
    expect(wt!.status).toBe("active");
    expect(wt!.tmuxWindow).toBe("neo-freelance");
  });

  it("fleet-numeric session name (`NN-<oracle>`) — parent still matched via suffix", async () => {
    // Sessions like `114-mawjs` follow the fleet `NN-<oracle>` convention.
    // The parent-session selector accepts `name === oracle` OR
    // `name.endsWith(-${oracle})` so this should resolve in-scope, not via
    // global fall-through.
    stubFindOutput = [
      wtPath("Org", "mawjs-oracle",   "1--no-attach"),
      wtPath("Org", "another-oracle", "1--no-attach"),
    ].join("\n");
    stubSessions = [
      { name: "114-mawjs",   windows: [win("mawjs--no-attach")] },
      { name: "200-another", windows: [win("another--no-attach")] },
    ];

    const errLogs: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => { errLogs.push(a.map(String).join(" ")); };

    try {
      const results = await scanWorktrees();
      const mawjs = results.find(r => r.path.includes("/mawjs-oracle/"));
      const another = results.find(r => r.path.includes("/another-oracle/"));
      expect(mawjs!.status).toBe("active");
      expect(mawjs!.tmuxWindow).toBe("mawjs--no-attach");
      expect(another!.status).toBe("active");
      expect(another!.tmuxWindow).toBe("another--no-attach");
      expect(errLogs.join("\n")).not.toContain("ambiguous");
    } finally {
      console.error = origErr;
    }
  });

  it("parent session exists but window lives elsewhere → falls through to global", async () => {
    // `pulse` session is up but `--no-attach` only exists in `timekeeper`.
    // Scoped search finds nothing (kind: none) → global fall-through resolves
    // to the timekeeper window (single match — no ambiguity).
    stubFindOutput = wtPath("Org", "pulse-oracle", "1--no-attach");
    stubSessions = [
      { name: "pulse",      windows: [win("pulse-something-else")] },
      { name: "timekeeper", windows: [win("timekeeper--no-attach")] },
    ];

    const results = await scanWorktrees();
    const wt = results.find(r => r.name === "1--no-attach");
    expect(wt).toBeDefined();
    // Single global match remains — current behavior preserved.
    expect(wt!.status).toBe("active");
    expect(wt!.tmuxWindow).toBe("timekeeper--no-attach");
  });
});
