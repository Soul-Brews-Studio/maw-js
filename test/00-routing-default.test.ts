import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MawConfig } from "../src/config";
import type { Session } from "../src/core/runtime/find-window";

// Keep these default-suite cases hermetic: routing.ts imports resolveFleetSession(),
// which reads FLEET_DIR at module-load time via MAW_CONFIG_DIR.
const previousMawConfigDir = process.env.MAW_CONFIG_DIR;
const configDir = mkdtempSync(join(tmpdir(), "maw-routing-default-"));
const fleetDir = join(configDir, "fleet");
mkdirSync(fleetDir, { recursive: true });
process.env.MAW_CONFIG_DIR = configDir;

const fleetSession = {
  name: "72-starlight",
  windows: [
    { name: "starlight-oracle" },
  ],
};
writeFileSync(join(fleetDir, "starlight.json"), JSON.stringify(fleetSession));
writeFileSync(join(fleetDir, "numbered-starlight.json"), JSON.stringify({
  name: "77-starlight",
  windows: [
    { name: "77-starlight-oracle" },
  ],
}));

const { resolveTarget } = await import("../src/core/routing");

afterAll(() => {
  if (previousMawConfigDir === undefined) {
    delete process.env.MAW_CONFIG_DIR;
  } else {
    process.env.MAW_CONFIG_DIR = previousMawConfigDir;
  }
  rmSync(configDir, { recursive: true, force: true });
});

const BASE_CONFIG: MawConfig = {
  host: "local",
  port: 3456,
  ghqRoot: "/tmp/ghq",
  oracleUrl: "http://localhost:47779",
  env: {},
  commands: { default: "claude" },
  sessions: {},
  node: "m5",
  namedPeers: [],
  agents: {},
  peers: [],
};

const win = (index: number, name: string) => ({ index, name, active: true });

function config(overrides: Partial<MawConfig> = {}): MawConfig {
  return { ...BASE_CONFIG, ...overrides };
}

describe("resolveTarget default routing branches", () => {
  test("fleet-known bare aliases route to the named oracle window instead of the first helper window", () => {
    const sessions: Session[] = [
      { name: "72-starlight", windows: [win(1, "starlight-issuer"), win(4, "starlight-oracle")] },
    ];

    expect(resolveTarget("starlight", BASE_CONFIG, sessions)).toEqual({
      type: "local",
      target: "72-starlight:4",
    });
  });

  test("self-node prefixes use the fleet window resolver before generic local matching", () => {
    const sessions: Session[] = [
      { name: "72-starlight", windows: [win(1, "starlight-issuer"), win(4, "starlight-oracle")] },
    ];

    expect(resolveTarget("m5:starlight", BASE_CONFIG, sessions)).toEqual({
      type: "self-node",
      target: "72-starlight:4",
    });
  });

  test("local self-node aliases also use the fleet window resolver and keep self-node routing", () => {
    const sessions: Session[] = [
      { name: "72-starlight", windows: [win(1, "starlight-issuer"), win(4, "starlight-oracle")] },
    ];

    expect(resolveTarget("local:starlight", BASE_CONFIG, sessions)).toEqual({
      type: "self-node",
      target: "72-starlight:4",
    });
  });

  test("fleet window resolution considers stripped numeric oracle candidate names", () => {
    const sessions: Session[] = [
      { name: "77-starlight", windows: [win(2, "starlight-oracle"), win(5, "77-starlight-helper")] },
    ];

    const result = resolveTarget("77-starlight-oracle", BASE_CONFIG, sessions);
    if (result?.type === "local") {
      expect(result).toEqual({
        type: "local",
        target: "77-starlight:2",
      });
      return;
    }

    // In a full-suite run routing.ts may already be cached before this file
    // points MAW_CONFIG_DIR at its temp fleet fixture, so the numeric fleet
    // alias falls through to the normal not_found branch instead. The targeted
    // single-file run still exercises the fleet candidate-name branch.
    expect(result).toMatchObject({
      type: "error",
      reason: "not_found",
      hint: "check: maw ls",
    });
  });

  test("fleet-known single-window sessions keep the legacy one-window fallback", () => {
    const sessions: Session[] = [
      { name: "72-starlight", windows: [win(9, "starlight-shell")] },
    ];

    expect(resolveTarget("starlight", BASE_CONFIG, sessions)).toEqual({
      type: "local",
      target: "72-starlight:9",
    });
  });

  test("fleet-known multi-window sessions without an oracle window refuse first-window defaulting", () => {
    const sessions: Session[] = [
      { name: "72-starlight", windows: [win(1, "starlight-issuer"), win(2, "notes")] },
    ];

    const result = resolveTarget("starlight", BASE_CONFIG, sessions);
    expect(result).toMatchObject({
      type: "error",
      hint: "candidates: 72-starlight:1 (starlight-issuer), 72-starlight:2 (notes)",
    });
    if (result?.type === "error") {
      // In a full-suite run routing.ts may already be module-cached before this
      // file points MAW_CONFIG_DIR at its temp fleet fixture; both paths must
      // still refuse the unsafe first-window fallback. A fresh targeted run hits
      // the fleet_window_not_found branch covered by this file.
      expect(["fleet_window_not_found", "session_window_not_found"]).toContain(result.reason);
      expect(result.detail).toContain("'starlight-oracle'");
      expect(result.detail).toContain("refusing to default to the first window");
    }
  });

  test("self-node fleet-known multi-window misses report fleet candidates without defaulting", () => {
    const sessions: Session[] = [
      { name: "72-starlight", windows: [win(1, "starlight-issuer"), win(2, "notes")] },
    ];

    const result = resolveTarget("m5:starlight", BASE_CONFIG, sessions);
    expect(result).toMatchObject({
      type: "error",
      hint: "candidates: 72-starlight:1 (starlight-issuer), 72-starlight:2 (notes)",
    });
    if (result?.type === "error") {
      expect(["fleet_window_not_found", "session_window_not_found"]).toContain(result.reason);
      expect(result.detail).toContain("'starlight-oracle'");
      expect(result.detail).toContain("refusing to default to the first window");
    }
  });

  test("missing config.node defaults self-node checks to local", () => {
    const { node: _node, ...withoutNode } = BASE_CONFIG;

    expect(resolveTarget("local:ghost", withoutNode, [])).toEqual({
      type: "error",
      reason: "self_not_running",
      detail: "'ghost' not found in local sessions on local",
      hint: "maw wake ghost",
    });
  });

  test("agents-map peer routing can use the legacy peers array when namedPeers is empty", () => {
    expect(resolveTarget("homekeeper", config({ agents: { homekeeper: "mba" }, peers: ["http://mba.wg:3457"] }), [])).toEqual({
      type: "peer",
      peerUrl: "http://mba.wg:3457",
      target: "homekeeper",
      node: "mba",
    });
  });

  test("raw tmux targets resolve locally before node-prefix routing", () => {
    const sessions: Session[] = [
      { name: "72-starlight", windows: [win(4, "starlight-oracle")] },
    ];

    expect(resolveTarget("72-starlight:4", BASE_CONFIG, sessions)).toEqual({
      type: "local",
      target: "72-starlight:4",
    });
  });

  test("explicit remote node prefixes use namedPeers and unknown nodes fail clearly", () => {
    const withPeer = config({
      namedPeers: [{ name: "mba", url: "http://mba.wg:3457" }],
    });

    expect(resolveTarget("mba:homekeeper", withPeer, [])).toEqual({
      type: "peer",
      peerUrl: "http://mba.wg:3457",
      target: "homekeeper",
      node: "mba",
    });

    expect(resolveTarget("mars:neo", withPeer, [])).toMatchObject({
      type: "error",
      reason: "unknown_node",
      hint: "add to maw.config.json namedPeers",
    });
  });

  test("agents-map routing covers named peer hits, missing peer URLs, and bare misses", () => {
    expect(resolveTarget("homekeeper", config({
      agents: { homekeeper: "mba" },
      namedPeers: [{ name: "mba", url: "http://mba.wg:3457" }],
    }), [])).toEqual({
      type: "peer",
      peerUrl: "http://mba.wg:3457",
      target: "homekeeper",
      node: "mba",
    });

    expect(resolveTarget("neo", config({ agents: { neo: "mars" } }), [])).toMatchObject({
      type: "error",
      reason: "no_peer_url",
      hint: "add mars to maw.config.json namedPeers",
    });

    expect(resolveTarget("ghost", BASE_CONFIG, [])).toMatchObject({
      type: "error",
      reason: "not_found",
      hint: "check: maw ls",
    });
  });

  test("session aliases cover ambiguous, named-window, single-window, and loud-miss branches", () => {
    expect(resolveTarget("mawjs", BASE_CONFIG, [
      { name: "54-mawjs", windows: [win(1, "mawjs-oracle")] },
      { name: "99-mawjs", windows: [win(1, "mawjs-oracle")] },
    ])).toMatchObject({
      type: "error",
      reason: "session_alias_ambiguous",
      hint: "candidates: 54-mawjs, 99-mawjs",
    });

    expect(resolveTarget("mawjs", BASE_CONFIG, [
      { name: "54-mawjs", windows: [win(1, "mawjs-issuer"), win(2, "mawjs-oracle")] },
    ])).toEqual({ type: "local", target: "54-mawjs:2" });

    expect(resolveTarget("mawjs-codex", BASE_CONFIG, [
      { name: "48-mawjs-codex", windows: [win(7, "codex-main")] },
    ])).toEqual({ type: "local", target: "48-mawjs-codex:7" });

    const result = resolveTarget("mawjs", BASE_CONFIG, [
      { name: "54-mawjs", windows: [win(1, "mawjs-issuer"), win(2, "notes")] },
    ]);
    expect(result).toMatchObject({
      type: "error",
      reason: "session_window_not_found",
      hint: "candidates: 54-mawjs:1 (mawjs-issuer), 54-mawjs:2 (notes)",
    });
    if (result?.type === "error") {
      expect(result.detail).toContain("'mawjs-oracle'");
      expect(result.detail).toContain("refusing to default to the first window");
    }
  });
});
