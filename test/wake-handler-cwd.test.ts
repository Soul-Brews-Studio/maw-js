import { describe, test, expect, mock } from "bun:test";

// Mock loadFleet + getGhqRoot before importing the unit under test so the
// resolver reads our fixtures instead of touching ~/.config/maw/fleet.
const mockFleets = [
  {
    name: "05-acme",
    windows: [{ name: "acme-oracle", repo: "acme-app" }],
  },
  {
    name: "02-neo",
    windows: [{ name: "neo-oracle", repo: "neo-oracle" }],
  },
  {
    // multi-window session with DIFFERENT repos per window — the off-by-one
    // made `:1` resolve to the second window's repo (wrong owner inbox).
    name: "31-erp",
    windows: [
      { name: "erp-oracle", repo: "erp-oracle" },
      { name: "erp-worker", repo: "erp-worker-repo" },
    ],
  },
];

// Mock the WHOLE module surface — partial mocks pollute the bun test process
// and cause "SyntaxError: Export named X not found" in any later test (or
// transitively-imported source) that resolves a missing named export against
// our truncated mock. See: bun mock.module is process-wide.
mock.module("../src/commands/shared/fleet-load", () => ({
  loadFleet: () => mockFleets,
  loadFleetEntries: () =>
    mockFleets.map((session) => {
      const m = session.name.match(/^(\d+)-(.+)$/);
      const num = m ? parseInt(m[1], 10) : 0;
      const groupName = m ? m[2] : session.name;
      return { file: `${session.name}.json`, num, groupName, session };
    }),
  getSessionNames: async () => mockFleets.map((f) => f.name),
}));

mock.module("../src/config/ghq-root", () => ({
  getGhqRoot: () => "/tmp/ghq",
}));

const { extractOracleName, resolveTargetCwd, shellQuote } = await import("../src/commands/shared/target-cwd");

describe("extractOracleName", () => {
  test("strips numeric prefix from session — 05-acme → acme", () => {
    expect(extractOracleName("05-acme:0")).toBe("acme");
    expect(extractOracleName("05-acme:acme-oracle")).toBe("acme-oracle");
    expect(extractOracleName("05-acme")).toBe("acme");
  });

  test("resolves by window name when target is node:session:window", () => {
    expect(extractOracleName("m5:05-acme:acme-oracle")).toBe("acme-oracle");
    expect(extractOracleName("m5:05-acme:0")).toBe("acme");
  });

  test("session without numeric prefix is passed through", () => {
    expect(extractOracleName("standalone:0")).toBe("standalone");
  });

  test("empty / malformed targets degrade to empty string", () => {
    expect(extractOracleName("")).toBe("");
    expect(extractOracleName(":0")).toBe("");
  });
});

describe("resolveTargetCwd", () => {
  test("session:window-number resolves via fleet config — tmux numbers are 1-based", () => {
    // tmux base-index=1: window `1` is the first window = fleet.windows[0].
    expect(resolveTargetCwd("05-acme:1")).toBe("/tmp/ghq/acme-app");
    expect(resolveTargetCwd("02-neo:1")).toBe("/tmp/ghq/neo-oracle");
  });

  // Regression: the off-by-one (indexing fleet.windows directly by the tmux
  // window number) made `:1` on a 1-window session resolve to null, and on a
  // multi-window session resolve to the NEXT window's repo (wrong-owner inbox).
  test("off-by-one: a 1-window session addressed as :1 resolves (was null)", () => {
    expect(resolveTargetCwd("02-neo:1")).toBe("/tmp/ghq/neo-oracle");
  });

  test("off-by-one: multi-window :1 → first repo, :2 → second repo (no cross-owner)", () => {
    expect(resolveTargetCwd("31-erp:1")).toBe("/tmp/ghq/erp-oracle");
    expect(resolveTargetCwd("31-erp:2")).toBe("/tmp/ghq/erp-worker-repo");
  });

  test("window :0 has no window under base-index=1 → null", () => {
    expect(resolveTargetCwd("05-acme:0")).toBeNull();
    expect(resolveTargetCwd("31-erp:0")).toBeNull();
  });

  test("session:window-name resolves via fleet config", () => {
    expect(resolveTargetCwd("05-acme:acme-oracle")).toBe("/tmp/ghq/acme-app");
    expect(resolveTargetCwd("02-neo:neo-oracle")).toBe("/tmp/ghq/neo-oracle");
  });

  test("bare session (no window) defaults to first window", () => {
    expect(resolveTargetCwd("05-acme")).toBe("/tmp/ghq/acme-app");
  });

  test("unknown session returns null — caller falls back to bare cmd", () => {
    expect(resolveTargetCwd("99-ghost:0")).toBeNull();
  });

  test("unknown window-index returns null", () => {
    expect(resolveTargetCwd("05-acme:99")).toBeNull();
  });

  test("unknown window-name returns null", () => {
    expect(resolveTargetCwd("05-acme:does-not-exist")).toBeNull();
  });

  test("empty target returns null", () => {
    expect(resolveTargetCwd("")).toBeNull();
  });
});

describe("shellQuote", () => {
  test("wraps simple paths in single quotes", () => {
    expect(shellQuote("/tmp/ghq/acme-app")).toBe("'/tmp/ghq/acme-app'");
  });

  test("escapes embedded single quotes", () => {
    expect(shellQuote("/it's/odd")).toBe("'/it'\\''s/odd'");
  });
});
