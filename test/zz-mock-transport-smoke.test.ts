/**
 * Smoke test for test/helpers/mock-tmux.ts — verifies the helper installs
 * cleanly, returns configured data, captures commands, and resets between
 * tests without polluting subsequent reads.
 *
 * ISOLATION: This file MUST run in a separate bun test process
 * (`bun run test:mock-smoke`). bun's mock.module() is process-global AND
 * retroactive — once installTmuxMock() calls mock.module for the tmux
 * transport, the real Tmux class is replaced for ALL test files in the
 * same process, breaking tmux.test.ts and split-lock.test.ts. The main
 * suite (`bun run test`) excludes this file via --path-ignore-patterns.
 *
 * Kept as a separate file (not in engine.test.ts) so it doesn't fight
 * engine-isolator's work on the MawEngine test runner.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  installTmuxMock,
  installPeersMock,
  resetMocks,
  setPaneCommands,
  getCapturedCommands,
  type MockSession,
} from "./helpers/mock-tmux";

describe("mock-tmux helper", () => {
  afterEach(() => resetMocks());

  test("installTmuxMock makes tmux.listAll() return configured sessions", async () => {
    const sessions: MockSession[] = [
      { name: "oracles", windows: [{ index: 1, name: "pulse-oracle", active: true }] },
    ];
    installTmuxMock({ sessions });

    const { tmux } = await import("../src/core/transport/tmux");
    const result = await tmux.listAll();

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("oracles");
    expect(result[0].windows[0].name).toBe("pulse-oracle");
  });

  test("setPaneCommands controls getPaneCommands() output", async () => {
    installTmuxMock({ sessions: [] });
    setPaneCommands({ "oracles:1": "claude", "oracles:2": "zsh" });

    const { tmux } = await import("../src/core/transport/tmux");
    const cmds = await tmux.getPaneCommands(["oracles:1", "oracles:2", "oracles:3"]);

    expect(cmds["oracles:1"]).toBe("claude");
    expect(cmds["oracles:2"]).toBe("zsh");
    expect(cmds["oracles:3"]).toBeUndefined();
  });

  test("getCapturedCommands records tmux calls for assertions", async () => {
    installTmuxMock({ sessions: [{ name: "s", windows: [] }] });

    const { tmux } = await import("../src/core/transport/tmux");
    await tmux.listAll();
    await tmux.hasSession("s");

    const captured = getCapturedCommands();
    expect(captured.some(c => c.includes("list-windows -a"))).toBe(true);
    expect(captured.some(c => c.includes("has-session -t s"))).toBe(true);
  });

  test("installPeersMock makes getPeers() return configured URLs", async () => {
    installPeersMock({
      peers: [
        { url: "http://mba.wg:3457", sessions: [] },
        { url: "http://clinic.wg:3457", sessions: [] },
      ],
    });

    const { getPeers } = await import("../src/core/transport/peers");
    expect(getPeers()).toEqual(["http://mba.wg:3457", "http://clinic.wg:3457"]);
  });

  test("getAggregatedSessions merges local + peer sessions with source tags", async () => {
    installPeersMock({
      peers: [
        {
          url: "http://mba.wg:3457",
          sessions: [{ name: "remote-s", windows: [{ index: 0, name: "w", active: true }] }],
        },
      ],
    });

    const { getAggregatedSessions } = await import("../src/core/transport/peers");
    const result = await getAggregatedSessions([
      { name: "local-s", windows: [{ index: 0, name: "w", active: true }] } as any,
    ]);

    expect(result).toHaveLength(2);
    expect(result.find(s => s.name === "local-s")?.source).toBe("local");
    expect(result.find(s => s.name === "remote-s")?.source).toBe("http://mba.wg:3457");
  });

  test("resetMocks clears state — next read sees empty sessions", async () => {
    installTmuxMock({ sessions: [{ name: "x", windows: [] }] });
    resetMocks();

    const { tmux } = await import("../src/core/transport/tmux");
    expect(await tmux.listAll()).toEqual([]);
    expect(getCapturedCommands().filter(c => c.includes("list-windows -a"))).toHaveLength(1);
    // ^ this read happened AFTER reset, so capturedCommands starts fresh
  });
});
