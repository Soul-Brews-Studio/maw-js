/**
 * wake-concurrency.test.ts — regression for maw-stress finding #2.
 *
 * `cmdWake` had no count / queue / cap — nothing stopped a script or a
 * runaway orchestrator from spawning agents until the box fell over.
 * `src/commands/shared/wake-concurrency.ts` adds an opt-in cap
 * (`limits.maxConcurrentAgents`); `cmdWake` calls `assertAgentCapacity`
 * before every net-new spawn.
 *
 * Isolated: installs the tmux mock + a config mock (both mock.module, which
 * is process-global). Pure decision logic (`checkCapacity`) is also pinned
 * here — it needs no mocks but lives with its siblings.
 */
import { describe, test, expect, beforeAll, afterEach, mock } from "bun:test";
import { join } from "path";
import { installTmuxMock, setPanes, getCapturedCommands, resetMocks } from "../helpers/mock-tmux";

const root = join(import.meta.dir, "../..");

// Controllable cap value — assertAgentCapacity reads it via cfgLimit().
let capValue = 0;
let capSourcePath: string | null = null;

// tmux mock first, then config mock — both mock.module, registered before the
// dynamic import in beforeAll so wake-concurrency.ts resolves to the shims.
installTmuxMock({ sessions: [] });

mock.module(join(root, "src/config"), () => {
  const { mockConfigModule } = require("../helpers/mock-config");
  const base = mockConfigModule(() => ({ node: "test-node", commands: {} }));
  return {
    ...base,
    cfgLimit: (k: string) =>
      k === "maxConcurrentAgents" ? capValue : base.cfgLimit(k),
    loadConfigWithProvenance: () => ({
      config: { limits: { maxConcurrentAgents: capValue } },
      sources: capSourcePath ? [{ path: capSourcePath, weight: 50, scope: "user", isLocal: false }] : [],
      provenance: capSourcePath ? {
        "limits.maxConcurrentAgents": [{
          path: capSourcePath,
          weight: 50,
          scope: "user",
          isLocal: false,
          value: capValue,
          action: "set",
        }],
      } : {},
      warnings: [],
    }),
  };
});

let checkCapacity: typeof import("../../src/commands/shared/wake-concurrency").checkCapacity;
let countLiveAgents: typeof import("../../src/commands/shared/wake-concurrency").countLiveAgents;
let assertAgentCapacity: typeof import("../../src/commands/shared/wake-concurrency").assertAgentCapacity;
let maxConcurrentAgentsSourceLine: typeof import("../../src/commands/shared/wake-concurrency").maxConcurrentAgentsSourceLine;

beforeAll(async () => {
  const mod = await import("../../src/commands/shared/wake-concurrency");
  checkCapacity = mod.checkCapacity;
  countLiveAgents = mod.countLiveAgents;
  assertAgentCapacity = mod.assertAgentCapacity;
  maxConcurrentAgentsSourceLine = mod.maxConcurrentAgentsSourceLine;
});

afterEach(() => {
  resetMocks();
  capValue = 0;
  capSourcePath = null;
});

describe("checkCapacity — pure cap decision (#2)", () => {
  test("cap 0 / negative → disabled, never throws", () => {
    expect(() => checkCapacity(999, 0, "x")).not.toThrow();
    expect(() => checkCapacity(999, -1, "x")).not.toThrow();
  });

  test("under cap → no throw", () => {
    expect(() => checkCapacity(3, 5, "neo")).not.toThrow();
  });

  test("at cap → throws (over-cap path)", () => {
    expect(() => checkCapacity(5, 5, "neo")).toThrow(/5\/5/);
    expect(() => checkCapacity(5, 5, "neo")).toThrow(/refusing to spawn 'neo'/);
  });

  test("over cap → throws", () => {
    expect(() => checkCapacity(8, 5, "pulse")).toThrow(/8\/5/);
  });

  test("error message is actionable — names the config set command", () => {
    expect(() => checkCapacity(5, 5, "neo")).toThrow(/maw config set limits\.maxConcurrentAgents 6/);
  });

  test("error message can include the exact config source line", () => {
    expect(() => checkCapacity(5, 5, "neo", "limits.maxConcurrentAgents: 5 from /tmp/maw.config.50.json"))
      .toThrow(/Config: limits\.maxConcurrentAgents: 5 from \/tmp\/maw\.config\.50\.json/);
  });
});

describe("countLiveAgents — counts agent panes across the fleet", () => {
  test("counts only agent-process panes (claude / node), ignores shells", async () => {
    setPanes([
      { command: "claude" },
      { command: "node" },
      { command: "zsh" },
      { command: "bash" },
      { command: "claude" },
    ]);
    expect(await countLiveAgents()).toBe(3);
  });

  test("no panes → 0", async () => {
    setPanes([]);
    expect(await countLiveAgents()).toBe(0);
  });
});

describe("maxConcurrentAgentsSourceLine — explains where the cap came from", () => {
  test("reports the full config path when provenance names a source file", () => {
    capValue = 7;
    capSourcePath = "/Users/nat/.config/maw/maw.config.50.json";

    expect(maxConcurrentAgentsSourceLine()).toBe(
      "limits.maxConcurrentAgents: 7 from /Users/nat/.config/maw/maw.config.50.json",
    );
  });

  test("reports built-in default when no config file sets the cap", () => {
    capValue = 10;
    capSourcePath = null;

    expect(maxConcurrentAgentsSourceLine()).toBe("limits.maxConcurrentAgents: 10 from built-in default");
  });
});

describe("assertAgentCapacity — the guard cmdWake calls before spawning", () => {
  test("disabled (cap 0) → no throw, and does NOT even query tmux", async () => {
    capValue = 0;
    setPanes([{ command: "claude" }, { command: "claude" }, { command: "claude" }]);
    await assertAgentCapacity("neo");
    // fast-path: disabled cap must skip the list-panes call entirely
    expect(getCapturedCommands().some(c => c.includes("list-panes"))).toBe(false);
  });

  test("under cap → resolves", async () => {
    capValue = 5;
    setPanes([{ command: "claude" }, { command: "node" }]);
    await assertAgentCapacity("neo");
    expect(getCapturedCommands().some(c => c.includes("list-panes"))).toBe(true);
  });

  test("at/over cap → rejects loudly with the config source path", async () => {
    capValue = 2;
    capSourcePath = "/tmp/maw/maw.config.90.local.json";
    setPanes([{ command: "claude" }, { command: "claude" }, { command: "node" }]);

    await expect(assertAgentCapacity("neo")).rejects.toThrow(/concurrency cap reached: 3\/2/);
    await expect(assertAgentCapacity("neo")).rejects.toThrow(/Config: limits\.maxConcurrentAgents: 2 from \/tmp\/maw\/maw\.config\.90\.local\.json/);
    await expect(assertAgentCapacity("neo")).rejects.toThrow(/maw config set limits\.maxConcurrentAgents 4/);
  });

  test("exactly at cap → rejects (cap is inclusive)", async () => {
    capValue = 2;
    setPanes([{ command: "claude" }, { command: "claude" }]);
    await expect(assertAgentCapacity("pulse")).rejects.toThrow(/2\/2/);
  });
});
