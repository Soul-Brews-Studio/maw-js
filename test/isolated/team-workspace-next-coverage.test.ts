import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type OracleRegistry = {
  members: Array<{ oracle: string; role: string; addedAt: string }>;
};

let sessionExists = new Set<string>();
let tmuxRunResult = "";
let tmuxRunError: Error | undefined;
let selectLayoutFailures = new Set<string>();
let layoutCalls: Array<{ target: string; layout: string }> = [];
let wakeCalls: Array<{ oracle: string; opts: Record<string, unknown> }> = [];
let compactCalls: Array<{ target: string; opts: Record<string, unknown> }> = [];
let compactError: Error | undefined;
let registry: OracleRegistry | null = null;
let warnings: string[] = [];

const originalTmux = process.env.TMUX;
const originalWarn = console.warn;

mock.module("maw-js/sdk", () => ({
  tmux: {
    hasSession: async (name: string) => sessionExists.has(name),
    run: async () => {
      if (tmuxRunError) throw tmuxRunError;
      return tmuxRunResult;
    },
    selectLayout: async (target: string, layout: string) => {
      layoutCalls.push({ target, layout });
      if (selectLayoutFailures.has(target)) throw new Error(`layout failed for ${target}`);
    },
  },
}));

mock.module("maw-js/commands/shared/wake", () => ({
  cmdWake: async (oracle: string, opts: Record<string, unknown>) => {
    wakeCalls.push({ oracle, opts });
    return `${opts.session}:${oracle}`;
  },
}));

mock.module("maw-js/commands/shared/context-limit", () => ({
  compactIfPaneContextLimited: async (target: string, opts: Record<string, unknown>) => {
    compactCalls.push({ target, opts });
    if (compactError) throw compactError;
    return false;
  },
}));

mock.module("../../src/vendor/mpr-plugins/team/oracle-members", () => ({
  loadOracleRegistry: () => registry,
}));

const {
  applyTeamBringLayout,
  cmdTeamBring,
  resolveTeamBringSession,
} = await import("../../src/vendor/mpr-plugins/team/team-workspace");

beforeEach(() => {
  sessionExists = new Set<string>();
  tmuxRunResult = "";
  tmuxRunError = undefined;
  selectLayoutFailures = new Set<string>();
  layoutCalls = [];
  wakeCalls = [];
  compactCalls = [];
  compactError = undefined;
  registry = null;
  warnings = [];
  console.warn = (...parts: unknown[]) => warnings.push(parts.map(String).join(" "));
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
});

afterEach(() => {
  console.warn = originalWarn;
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
});

describe("team workspace next-pass coverage", () => {
  test("rejects invalid explicit tmux session names before probing tmux", async () => {
    await expect(resolveTeamBringSession("team-a", { session: "bad/name" }))
      .rejects.toThrow("invalid session name 'bad/name'");
    expect(layoutCalls).toEqual([]);
  });

  test("rejects missing explicit target sessions", async () => {
    await expect(resolveTeamBringSession("team-a", { session: "missing" }))
      .rejects.toThrow("target session 'missing' not found");
  });

  test("falls back to the current tmux session when no team-named workspace exists", async () => {
    process.env.TMUX = "/tmp/tmux-100/default,1,0";
    tmuxRunResult = "  current-workspace  \n";

    await expect(resolveTeamBringSession("team-a")).resolves.toBe("current-workspace");
  });

  test("reports the setup command when outside tmux with no team-named workspace", async () => {
    delete process.env.TMUX;

    await expect(resolveTeamBringSession("team-a"))
      .rejects.toThrow("not in tmux and no 'team-a' session exists");
  });

  test("treats failed tmux session lookup as outside tmux for session resolution", async () => {
    process.env.TMUX = "/tmp/tmux-100/default,1,0";
    tmuxRunError = new Error("display failed");

    await expect(resolveTeamBringSession("team-a"))
      .rejects.toThrow("not in tmux and no 'team-a' session exists");
  });

  test("falls back from lead layout target to window zero and chooses tiled for larger teams", async () => {
    selectLayoutFailures.add("workspace:lead");

    await expect(applyTeamBringLayout("workspace", 5)).resolves.toBe("tiled");

    expect(layoutCalls).toEqual([
      { target: "workspace:lead", layout: "tiled" },
      { target: "workspace:0", layout: "tiled" },
    ]);
  });

  test("ignores layout failures on both preferred and fallback windows", async () => {
    selectLayoutFailures.add("workspace:lead");
    selectLayoutFailures.add("workspace:0");

    await expect(applyTeamBringLayout("workspace", 5)).resolves.toBe("tiled");

    expect(layoutCalls).toEqual([
      { target: "workspace:lead", layout: "tiled" },
      { target: "workspace:0", layout: "tiled" },
    ]);
  });

  test("rejects bring when the team has no oracle members", async () => {
    registry = { members: [] };
    sessionExists.add("empty-team");

    await expect(cmdTeamBring("empty-team", { dryRun: true }))
      .rejects.toThrow("no oracle members in team 'empty-team'");
  });

  test("continues bring when context-limit probing fails for a woken pane", async () => {
    registry = {
      members: [{ oracle: "volt", role: "builder", addedAt: "2026-05-18T00:00:00Z" }],
    };
    sessionExists.add("workspace");
    compactError = new Error("probe exploded");

    await expect(cmdTeamBring("team-a", { session: "workspace", contextLimitPollMs: 0 }))
      .resolves.toEqual(["workspace:volt"]);

    expect(wakeCalls).toEqual([{
      oracle: "volt",
      opts: { session: "workspace", noRehydrate: true, engine: undefined, split: undefined },
    }]);
    expect(compactCalls).toEqual([{
      target: "workspace:volt",
      opts: { label: "workspace/volt", pollMs: 0 },
    }]);
    expect(warnings.join("\n")).toContain("context-limit probe failed (probe exploded)");
    expect(layoutCalls).toEqual([{ target: "workspace:lead", layout: "main-vertical" }]);
  });
});
