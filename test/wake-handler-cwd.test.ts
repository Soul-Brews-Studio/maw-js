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
    expect(extractOracleName("05-acme:acme-oracle")).toBe("acme");
    expect(extractOracleName("05-acme")).toBe("acme");
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
  test("session:window-index resolves via fleet config (the bug case)", () => {
    // The original handler did target.split(":").pop() which returned "0".
    // The fix needs to look up by index when the second segment is numeric.
    expect(resolveTargetCwd("05-acme:0")).toBe("/tmp/ghq/acme-app");
    expect(resolveTargetCwd("02-neo:0")).toBe("/tmp/ghq/neo-oracle");
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
