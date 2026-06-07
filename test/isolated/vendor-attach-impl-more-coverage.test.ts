import { beforeEach, describe, expect, mock, test } from "bun:test";

let resolveResult: any = null;
const listSessionsCalls: unknown[] = [];
const loadFleetCalls: unknown[] = [];
const logs: string[] = [];
const errors: string[] = [];

mock.module("maw-js/sdk", () => ({
  listSessions: async () => {
    listSessionsCalls.push([]);
    return [];
  },
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleet: async () => {
    loadFleetCalls.push([]);
    return [];
  },
}));

mock.module(import.meta.resolve("../../src/commands/plugins/tmux/impl"), () => ({
  cmdTmuxAttach: () => {},
}));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/attach/resolve-attach-target.ts"), () => ({
  resolveAttachTarget: async () => resolveResult,
}));

const { cmdAttach } = await import("../../src/vendor/mpr-plugins/attach/impl.ts?attach-impl-more-coverage");

beforeEach(() => {
  resolveResult = null;
  listSessionsCalls.length = 0;
  loadFleetCalls.length = 0;
  logs.length = 0;
  errors.length = 0;
  console.log = ((...args: unknown[]) => logs.push(args.join(" "))) as typeof console.log;
  console.error = ((...args: unknown[]) => errors.push(args.join(" "))) as typeof console.error;
});

describe("attach impl dry-run and validation branches", () => {
  test("rejects missing names with usage", async () => {
    await expect(cmdAttach("", { dryRun: true })).rejects.toThrow("name required");
    expect(errors.join("\n")).toContain("usage: maw attach");
  });

  test("dry-run reports missing local target without spawning wake", async () => {
    resolveResult = null;
    await cmdAttach("ghost", { dryRun: true });
    expect(logs.join("\n")).toContain("[dry-run] 'ghost' not local");
  });

  test("dry-run reports tier 1 live attach target", async () => {
    resolveResult = { tier: 1, sessionName: "54-mawjs" };
    await cmdAttach("mawjs", { dryRun: true });
    expect(logs.join("\n")).toContain("Tier 1 (live) — would attach to 54-mawjs");
  });

  test("dry-run reports tier 2 wake plan", async () => {
    resolveResult = { tier: 2, fleetName: "neo-oracle" };
    await cmdAttach("neo", { dryRun: true });
    expect(logs.join("\n")).toContain("Tier 2 (sleeping) — would wake neo-oracle, then attach");
  });

  test("ambiguous matches are listed and rejected", async () => {
    resolveResult = { tier: 1, sessionName: "unused", ambiguousCandidates: ["01-alpha", "02-alpha"] };
    await expect(cmdAttach("alpha", { dryRun: true })).rejects.toThrow("ambiguous: alpha");
    const rendered = errors.join("\n");
    expect(rendered).toContain("alpha' is ambiguous");
    expect(rendered).toContain("01-alpha");
    expect(rendered).toContain("02-alpha");
  });
});
