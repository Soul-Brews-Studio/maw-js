import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let cwd = "";
let logs: string[] = [];

const original = {
  cwd: process.cwd(),
  log: console.log,
};

mock.module("maw-js/sdk", () => ({
  hostExec: async () => "",
}));

mock.module("maw-js/config/ghq-root", () => ({
  getGhqRoot: () => cwd,
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleet: () => [],
}));

const { __dreamImplCoverageHooks } = await import("../../src/vendor/mpr-plugins/dream/impl.ts?ninth-pass-coverage");

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "maw-dream-ninth-cwd-"));
  logs = [];
  process.chdir(cwd);
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
});

afterEach(() => {
  process.chdir(original.cwd);
  console.log = original.log;
  rmSync(cwd, { recursive: true, force: true });
});

describe("dream impl ninth-pass private render/save coverage", () => {
  test("renders full dream sections and persists cross-project connections", () => {
    const pains = Array.from({ length: 9 }, (_, index) => dreamItem("pain", "alpha", `Alpha retry timeout pain ${index}`, {
      action: index === 0 ? "maw workon alpha" : undefined,
      confidence: index === 1 ? "medium" : index === 2 ? "low" : "high",
      daysAgo: index === 0 ? 0 : index === 1 ? 4 : 14,
      detail: `Detailed alpha branch ${index} ${"x".repeat(140)}`,
    }));
    const plan = dreamItem("plan", "alpha", "Alpha retry timeout plan", {
      detail: "Plan detail is long enough to render in all mode",
    });
    const memoryA = dreamItem("memory", "alpha", "Retry timeout pattern repeats across repos");
    const memoryB = dreamItem("memory", "beta", "Retry timeout pattern repeats in beta");

    const crossConnections = __dreamImplCoverageHooks.findConnections([memoryA, memoryB] as never);
    expect(crossConnections).toEqual([
      expect.objectContaining({ relation: "same pattern across repos" }),
    ]);

    const connections = [
      { from: pains[0]!, to: plan, relation: "has fix planned" },
      ...crossConnections,
    ];
    const insights = ["Cross-repo memory connected"];
    const items = [...pains, plan, memoryA, memoryB];

    __dreamImplCoverageHooks.renderDream(items as never, connections as never, insights, { all: true } as never);

    const output = logs.join("\n");
    expect(output).toContain("PAIN — blocking or broken");
    expect(output).toContain("PLAN — next steps from retros");
    expect(output).toContain("MEMORY — patterns that repeat");
    expect(output).toContain("… 1 more");
    expect(output).toContain("→ maw workon alpha");
    expect(output).toContain("Connections");
    expect(output).toContain("same pattern across repos");
    expect(output).toContain("Insights");
    expect(output).toContain("Cross-repo memory connected");

    const savedPath = __dreamImplCoverageHooks.saveDream(items as never, connections as never, insights, 2, true);
    const saved = readFileSync(savedPath, "utf8");
    expect(saved).toContain("## Connections");
    expect(saved).toContain("same pattern across repos");
    expect(saved).toContain("## Insights");
    expect(saved).toContain("Cross-repo memory connected");
  });
});

function dreamItem(category: string, project: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    category,
    title,
    detail: `Detail for ${title}`,
    source: `/tmp/${project}/ψ/memory/logs/info/2026-05-17_ninth.md`,
    project,
    confidence: "high",
    daysAgo: 1,
    ...overrides,
  };
}
