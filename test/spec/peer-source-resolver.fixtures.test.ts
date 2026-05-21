import { describe, expect, test } from "bun:test";
import fixtures from "./peer-source-resolver.fixtures.json";
import {
  configuredPeerTargets,
  dedupePeerTargets,
  formatPeerSources,
  parsePeerSourceMode,
  peerTargetsToConfigs,
  resolvePeerSources,
  type PeerSourceMode,
} from "../../src/commands/shared/peer-sources";
import type { MawConfig } from "../../src/config";
import type { DiscoveryError, DiscoveryResponse } from "../../src/vendor/mpr-plugins/peers/discovered";

type Fixture = {
  name: string;
  mode: PeerSourceMode;
  config: MawConfig;
  discoveries: DiscoveryResponse | DiscoveryError;
  expected: {
    urls: string[];
    names: Array<string | null>;
    sources: string[];
    warnings: string[];
    fetchCalls: number;
  };
};

describe("portable peer-source resolver fixtures (#1808)", () => {
  for (const fixture of fixtures as Fixture[]) {
    test(fixture.name, async () => {
      const calls: unknown[] = [];
      const result = await resolvePeerSources(fixture.config, fixture.mode, {
        fetchDiscoveries: async (opts) => {
          calls.push(opts);
          return fixture.discoveries;
        },
      });

      expect(result.mode).toBe(fixture.mode);
      expect(result.peers.map((peer) => peer.url)).toEqual(fixture.expected.urls);
      expect(result.peers.map((peer) => peer.name ?? null)).toEqual(fixture.expected.names);
      expect(result.peers.map((peer) => peer.source)).toEqual(fixture.expected.sources);
      for (const warning of fixture.expected.warnings) {
        expect(result.warnings.join("\n")).toContain(warning);
      }
      expect(calls).toHaveLength(fixture.expected.fetchCalls);
    });
  }

  test("parser accepts known modes, applies fallback, and rejects unknown modes", () => {
    expect(parsePeerSourceMode(undefined)).toBe("both");
    expect(parsePeerSourceMode("", "config")).toBe("config");
    expect(parsePeerSourceMode("scout")).toBe("scout");
    expect(parsePeerSourceMode("invalid")).toBeNull();
  });

  test("formatting and PeerConfig conversion cover empty, warning, and host-label paths", () => {
    expect(formatPeerSources({ mode: "both", peers: [], warnings: [] })).toBe("no peers discovered or configured");
    expect(formatPeerSources({ mode: "both", peers: [], warnings: ["scout unavailable"] })).toContain("warning: scout unavailable");

    const deduped = dedupePeerTargets([
      { url: "http://named:3456", name: "named", source: "config" },
      { url: "http://named:3456/", name: "duplicate", source: "scout" },
      { url: "not a url", source: "scout" },
    ]);
    expect(deduped).toHaveLength(2);
    expect(peerTargetsToConfigs(deduped)).toEqual([
      { name: "named", url: "http://named:3456" },
      { name: "not a url", url: "not a url" },
    ]);
    expect(formatPeerSources({ mode: "both", peers: deduped, warnings: ["fallback"] })).toContain("warning: fallback");
  });

  test("configuredPeerTargets dedupes flat peers before named peers", () => {
    expect(configuredPeerTargets({
      peers: ["http://same:3456"],
      namedPeers: [{ name: "same-name", url: "http://same:3456" }],
    } as MawConfig)).toEqual([{ url: "http://same:3456", source: "config" }]);
  });
});
