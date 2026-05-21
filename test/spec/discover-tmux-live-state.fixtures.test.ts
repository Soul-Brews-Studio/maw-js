import { describe, expect, test } from "bun:test";
import fixtures from "./discover-tmux-live-state.fixtures.json";
import {
  formatTmuxLiveState,
  markPeerTargetsLive,
  parseTmuxPaneTarget,
  resolveTmuxLiveState,
  type DiscoverLivePane,
} from "../../src/commands/shared/discover-live-state";
import type { PeerTarget } from "../../src/commands/shared/peer-sources";
import type { TmuxPane } from "../../src/core/transport/tmux";

type Fixture = {
  name: string;
  peers: PeerTarget[];
  panes: TmuxPane[];
  expected: {
    liveTargets: string[];
    sessions: string[];
    windows: string[];
    panes: string[];
    matches: string[][];
    awakePeers: string[];
  };
};

describe("discover tmux live-state fixtures (#1831)", () => {
  for (const fixture of fixtures as Fixture[]) {
    test(fixture.name, async () => {
      const result = await resolveTmuxLiveState(fixture.peers, {
        listPanes: async () => fixture.panes,
      });
      const peers = markPeerTargetsLive(fixture.peers, result.live);

      expect(result.live.map((pane) => pane.target)).toEqual(fixture.expected.liveTargets);
      expect(result.live.map((pane) => pane.session)).toEqual(fixture.expected.sessions);
      expect(result.live.map((pane) => pane.window)).toEqual(fixture.expected.windows);
      expect(result.live.map((pane) => pane.pane)).toEqual(fixture.expected.panes);
      expect(result.live.map((pane) => pane.matches)).toEqual(fixture.expected.matches);
      expect(peers.filter((peer) => peer.awake).map((peer) => peer.name ?? peer.node ?? peer.url)).toEqual(fixture.expected.awakePeers);
    });
  }

  test("target parser is a pure portable helper", () => {
    expect(parseTmuxPaneTarget("101-mawjs:agent.0")).toEqual({
      session: "101-mawjs",
      window: "agent",
      pane: "0",
    });
    expect(parseTmuxPaneTarget("not-a-pane-target")).toBeNull();
  });

  test("live-state resolver degrades list failures to warnings", async () => {
    const result = await resolveTmuxLiveState([], {
      listPanes: async () => {
        throw new Error("no server running");
      },
    });

    expect(result.live).toEqual([]);
    expect(result.warnings.join("\n")).toContain("tmux unavailable");
    expect(formatTmuxLiveState(result)).toContain("warning: tmux unavailable");
  });

  test("formatting includes live rows and unmatched marker", () => {
    const live: DiscoverLivePane[] = [{
      source: "tmux",
      id: "%1",
      target: "scratch:shell.0",
      session: "scratch",
      window: "shell",
      pane: "0",
      command: "zsh",
      cwd: "/tmp/scratch",
      awake: true,
      matches: [],
    }];

    const output = formatTmuxLiveState({ source: "tmux", live, warnings: [] });
    expect(output).toContain("scratch");
    expect(output).toContain("shell");
    expect(output).toContain("zsh");
    expect(output).toContain("-");
  });
});
