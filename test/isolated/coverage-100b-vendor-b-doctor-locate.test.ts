import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realFs from "fs";
import * as realChildProcess from "child_process";

let execMode: "pm2" | "bad-json" | "throw" = "pm2";
let ghqPath: string | null = "/repo/oracle";
let sessions: any[] = [];
let fleetEntries: any[] = [];
let config: any = { node: "fleet-node", agents: {} };
let existsPaths = new Set<string>();
let logs: string[] = [];
let errors: string[] = [];

mock.module("child_process", () => ({
  ...realChildProcess,
  execSync: (cmd: string) => {
    if (cmd.includes("pm2 jlist")) {
      if (execMode === "throw") throw new Error("no pm2");
      if (execMode === "bad-json") return "not json";
      return JSON.stringify([{ name: "maw", pm_id: 7, pm2_env: { env: { MAW_PORT: "4567" } } }]);
    }
    return "";
  },
}));
mock.module("fs", () => ({
  ...realFs,
  existsSync: (path: string) => existsPaths.has(path) || realFs.existsSync(path),
}));
mock.module("maw-js/core/ghq", () => ({ ghqFind: async () => ghqPath }));
mock.module("maw-js/sdk", () => ({
  listSessions: async () => sessions,
  FLEET_DIR: "/fleet",
  tmux: { listPaneIds: async () => new Set<string>(), killPane: async () => {} },
  hostExec: async () => "",
  curlFetch: async () => ({ ok: false, data: {} }),
  resolveTarget: () => null,
  Tmux: class {},
  takeSnapshot: async () => ({}),
}));
mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleetEntries: () => fleetEntries,
}));
mock.module("maw-js/config", () => ({ loadConfig: () => config }));
mock.module("maw-js/lib/oracle-manifest", () => ({
  invalidateManifest: () => undefined,
  loadManifestCached: () => [],
}));
mock.module("maw-js/core/matcher/resolve-target", () => ({
  resolveSessionTarget: (_oracle: string, list: any[]) => list.length ? { kind: "fuzzy", match: list[0] } : { kind: "none" },
}));

const doctor = await import("../../src/vendor/mpr-plugins/doctor/impl.ts?coverage-100b-doctor-impl");
const locate = await import("../../src/vendor/mpr-plugins/locate/impl.ts?coverage-100b-locate-impl");

const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;

beforeEach(() => {
  execMode = "pm2";
  ghqPath = "/repo/oracle";
  sessions = [];
  fleetEntries = [];
  config = { node: "fleet-node", agents: {} };
  existsPaths = new Set(["/repo/oracle/ψ"]);
  logs = [];
  errors = [];
  console.log = (...parts: unknown[]) => logs.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
  globalThis.fetch = (async () => { throw new Error("boom"); }) as typeof fetch;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  globalThis.fetch = originalFetch;
});

describe("coverage-100b vendor-b doctor and locate gaps", () => {
  test("doctor version check records probe exceptions and bad pm2 json as unavailable", async () => {
    const result = await doctor.cmdDoctor(["version"]);
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ name: "version:maw#7", ok: false, message: expect.stringContaining("unreachable at :4567") });

    execMode = "bad-json";
    const unavailable = await doctor.cmdDoctor(["version"]);
    expect(unavailable.ok).toBe(true);
    expect(unavailable.checks[0].message).toContain("pm2 unavailable");
  });

  test("locate prints repo psi and plural session details from migrated fleet path", async () => {
    sessions = [{ name: "123-alpha", windows: [{}, {}] }];
    fleetEntries = [{ file: "123-alpha.json", path: "/state/fleet/123-alpha.json", groupName: "alpha", session: { name: "123-alpha" } }];
    existsPaths.add("/fleet/123-alpha.json");
    config = { node: "this-node", agents: { alpha: "remote-node" } };

    await locate.cmdLocate("alpha");

    expect(logs.join("\n")).toContain("repo:     /repo/oracle");
    expect(logs.join("\n")).toContain("ψ/:       present");
    expect(logs.join("\n")).toContain("session:  123-alpha (2 windows)");
    expect(logs.join("\n")).toContain("fleet:    /state/fleet/123-alpha.json");
    expect(logs.join("\n")).toContain("node:     remote-node (from config.agents)");
  });

  test("locate path mode errors with session and fleet context when repo is missing", async () => {
    ghqPath = null;
    sessions = [{ name: "solo", windows: [{}] }];
    fleetEntries = [{ file: "solo.json", path: "/state/fleet/solo.json", groupName: "solo", session: { name: "solo" } }];

    await expect(locate.cmdLocate("solo", { path: true })).rejects.toThrow("no repo path for 'solo' (session: solo, fleet: yes)");
  });

  test("locate json mode can find oracle alias fleet configs without a live session", async () => {
    ghqPath = null;
    sessions = [];
    fleetEntries = [{ file: "alpha-oracle.json", path: "/state/fleet/alpha-oracle.json", groupName: "alpha-oracle", session: { name: "alpha-oracle" } }];

    await locate.cmdLocate("alpha", { json: true });

    const parsed = JSON.parse(logs[0]);
    expect(parsed.fleetConfigPath).toBe("/state/fleet/alpha-oracle.json");
    expect(parsed.sessionName).toBeNull();
  });
});
