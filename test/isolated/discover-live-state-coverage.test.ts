/** Targeted isolated coverage for src/commands/shared/discover-live-state.ts. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { TmuxPane } from "../../src/core/transport/tmux";

let panes: TmuxPane[] = [];

mock.module(import.meta.resolve("../../src/core/transport/tmux"), () => ({
  tmux: {
    listPanes: async () => panes,
  },
}));

const {
  formatTmuxLiveState,
  markPeerTargetsLive,
  parseTmuxPaneTarget,
  resolveTmuxLiveState,
} = await import("../../src/commands/shared/discover-live-state");

describe("discover live-state isolated coverage", () => {
  beforeEach(() => {
    panes = [];
  });

  test("default tmux source resolves pane targets, fallback targets, matches, and peer awake metadata", async () => {
    panes = [
      {
        id: "%1",
        command: "claude",
        target: "101-mawjs-oracle:agent.0",
        title: "MAWJS",
        pid: 101,
        cwd: "/repo/mawjs-oracle",
        lastActivity: 123,
      },
      {
        id: "%2",
        command: "",
        target: "scratch",
        title: "",
        cwd: "",
      },
    ];

    const result = await resolveTmuxLiveState([
      { name: "mawjs", url: "http://mawjs:3456", source: "config" },
      { name: "sleeping", url: "http://sleeping:3456", source: "scout", oracle: "sleeping-oracle" },
    ]);
    const peers = markPeerTargetsLive(result.live.length ? [
      { name: "mawjs", url: "http://mawjs:3456", source: "config" },
      { name: "sleeping", url: "http://sleeping:3456", source: "scout", oracle: "sleeping-oracle" },
    ] : [], result.live);

    expect(result.source).toBe("tmux");
    expect(result.warnings).toEqual([]);
    expect(result.live.map((pane) => pane.target)).toEqual(["101-mawjs-oracle:agent.0", "scratch"]);
    expect(result.live[0]).toMatchObject({
      session: "101-mawjs-oracle",
      window: "agent",
      pane: "0",
      command: "claude",
      title: "MAWJS",
      pid: 101,
      cwd: "/repo/mawjs-oracle",
      lastActivity: 123,
      awake: true,
      matches: ["mawjs"],
    });
    expect(result.live[1]).toMatchObject({
      session: "scratch",
      window: "",
      pane: "",
      command: undefined,
      title: undefined,
      cwd: undefined,
      matches: [],
    });
    expect(peers).toEqual([
      expect.objectContaining({
        name: "mawjs",
        awake: true,
        liveTargets: ["101-mawjs-oracle:agent.0"],
        liveSessions: ["101-mawjs-oracle"],
      }),
      expect.objectContaining({
        name: "sleeping",
        awake: false,
        liveTargets: [],
        liveSessions: [],
      }),
    ]);
  });

  test("parser and formatter cover invalid, empty, warning, and row paths", async () => {
    expect(parseTmuxPaneTarget("demo:win.2")).toEqual({ session: "demo", window: "win", pane: "2" });
    expect(parseTmuxPaneTarget(":win.2")).toBeNull();
    expect(parseTmuxPaneTarget("demo:.2")).toBeNull();
    expect(parseTmuxPaneTarget("demo:win.")).toBeNull();

    expect(formatTmuxLiveState({ source: "tmux", live: [], warnings: [] })).toBe("no live tmux sessions/windows found");
    expect(formatTmuxLiveState({
      source: "tmux",
      live: [{
        source: "tmux",
        id: "%9",
        target: "demo:win.2",
        session: "demo",
        window: "win",
        pane: "2",
        awake: true,
        matches: [],
      }],
      warnings: ["partial probe"],
    })).toContain("warning: partial probe");
  });

  test("list failures degrade to warnings for Error and non-Error throws", async () => {
    await expect(resolveTmuxLiveState([], {
      listPanes: async () => {
        throw new Error("no server");
      },
    })).resolves.toEqual({
      source: "tmux",
      live: [],
      warnings: ["tmux unavailable (no server)"],
    });

    await expect(resolveTmuxLiveState([], {
      listPanes: async () => {
        throw "offline";
      },
    })).resolves.toEqual({
      source: "tmux",
      live: [],
      warnings: ["tmux unavailable (offline)"],
    });
  });
});
