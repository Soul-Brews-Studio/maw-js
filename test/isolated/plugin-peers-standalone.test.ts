import { describe, expect, test } from "bun:test";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const duplicateDetect = await import("../../src/vendor/mpr-plugins/peers/duplicate-detect.ts?plugin-peers-standalone");

type Peer = {
  url: string;
  node: string | null;
  addedAt: string;
  lastSeen: string | null;
  identity?: { oracle: string; node: string };
};

function peer(url: string, identity?: { oracle: string; node: string }): Peer {
  return {
    url,
    node: identity?.node ?? null,
    addedAt: "2026-06-07T00:00:00.000Z",
    lastSeen: null,
    ...(identity ? { identity } : {}),
  };
}

function stripAnsi(value: string) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("peers plugin standalone boundary (#2413)", () => {
  test("documents current import boundary while peers finishes SDK extraction", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "peers",
      requireSdk: false,
      allowMawJs: ["maw-js/commands/shared/discovered-peers-client"],
      allowRelative: ["../../../core/xdg"],
    });

    expect(imports.map((record) => record.spec)).toContain("../../../core/xdg");
    expect(typeof duplicateDetect.findDuplicateIdentities).toBe("function");
  });

  test("finds stable duplicate identity claims and skips legacy peers", () => {
    const dups = duplicateDetect.findDuplicateIdentities({
      legacy: peer("http://legacy.local"),
      beta: peer("http://beta.local", { oracle: "mawjs", node: "m5" }),
      alpha: peer("http://alpha.local", { oracle: "mawjs", node: "m5" }),
      otherOracle: peer("http://other.local", { oracle: "oracle", node: "m5" }),
    });

    expect(dups).toEqual([
      {
        key: "mawjs:m5",
        claimants: [
          { alias: "beta", url: "http://beta.local" },
          { alias: "alpha", url: "http://alpha.local" },
        ],
      },
    ]);
    expect(duplicateDetect.formatDuplicate(dups[0])).toBe(
      'duplicate <oracle>:<node> claim "mawjs:m5" — beta (http://beta.local), alpha (http://alpha.local)',
    );
  });

  test("warnDuplicatesAtBoot warns once per unique collision and includes local identity", () => {
    const logs: string[] = [];
    const args = {
      peers: {
        selfAlias: peer("http://self.local", { oracle: "mawjs", node: "local" }),
        remote: peer("http://remote.local", { oracle: "mawjs", node: "remote" }),
      },
      local: { oracle: "mawjs", node: "local" },
      log: (msg: string) => logs.push(stripAnsi(msg)),
    };

    const first = duplicateDetect.warnDuplicatesAtBoot(args);
    const second = duplicateDetect.warnDuplicatesAtBoot(args);

    expect(first).toEqual([
      {
        key: "mawjs:local",
        claimants: [
          { alias: "<local>" },
          { alias: "selfAlias", url: "http://self.local" },
        ],
      },
    ]);
    expect(second).toEqual(first);
    expect(logs).toEqual([
      '⚠ duplicate <oracle>:<node> claim "mawjs:local" — <local>, selfAlias (http://self.local)',
      "  investigate with `maw peers list` and `maw peers remove <alias>` if stale.",
    ]);
  });
});
