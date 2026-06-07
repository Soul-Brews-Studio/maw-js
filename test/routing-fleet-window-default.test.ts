import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { MawConfig } from "../src/config";
import type { Session } from "../src/core/runtime/find-window";

let fleetSessions: Record<string, string | null> = {};

mock.module(join(import.meta.dir, "../src/commands/shared/wake"), () => ({
  resolveFleetSession: (oracle: string) => fleetSessions[oracle] ?? null,
}));

mock.module(join(import.meta.dir, "../src/lib/oracle-manifest"), () => ({
  loadManifestCached: () => [],
}));

const { resolveTarget } = await import("../src/core/routing");

const CONFIG: MawConfig = {
  host: "local",
  port: 3456,
  ghqRoot: "/home/nat/Code/github.com",
  oracleUrl: "http://localhost:47779",
  env: {},
  commands: { default: "claude" },
  sessions: {},
  node: "m5",
  namedPeers: [],
  agents: {},
  peers: [],
};

const MULTI_WINDOW_MAWJS: Session[] = [
  {
    name: "54-mawjs",
    windows: [
      { index: 1, name: "mawjs-issuer", active: true },
      { index: 2, name: "mawjs-oracle", active: false },
      { index: 3, name: "mawjs-smoke", active: false },
      { index: 4, name: "mawjs-codex-headless", active: false },
    ],
  },
];

describe("resolveTarget fleet window default coverage", () => {
  beforeEach(() => {
    fleetSessions = { mawjs: "54-mawjs" };
  });

  test("self-node fleet aliases prefer the named oracle window", () => {
    expect(resolveTarget("m5:mawjs", CONFIG, MULTI_WINDOW_MAWJS)).toEqual({
      type: "self-node",
      target: "54-mawjs:2",
    });
  });

  test("bare fleet aliases prefer the named oracle window before generic local fallback", () => {
    expect(resolveTarget("mawjs", CONFIG, MULTI_WINDOW_MAWJS)).toEqual({
      type: "local",
      target: "54-mawjs:2",
    });
  });

  test("multi-window fleet aliases fail loudly when the oracle window is missing", () => {
    const sessions: Session[] = [
      {
        name: "54-mawjs",
        windows: [
          { index: 1, name: "mawjs-issuer", active: true },
          { index: 3, name: "mawjs-smoke", active: false },
        ],
      },
    ];

    const result = resolveTarget("m5:mawjs", CONFIG, sessions);
    expect(result).toMatchObject({
      type: "error",
      reason: "fleet_window_not_found",
      hint: "candidates: 54-mawjs:1 (mawjs-issuer), 54-mawjs:3 (mawjs-smoke)",
    });
    if (result?.type === "error") {
      expect(result.detail).toContain("'mawjs-oracle'");
      expect(result.detail).toContain("refusing to default to the first window");
    }
  });

  test("single-window fleet aliases keep the unambiguous first-window fallback", () => {
    expect(resolveTarget("m5:mawjs", CONFIG, [
      { name: "54-mawjs", windows: [{ index: 7, name: "mawjs-issuer", active: true }] },
    ])).toEqual({
      type: "self-node",
      target: "54-mawjs:7",
    });
  });
});
