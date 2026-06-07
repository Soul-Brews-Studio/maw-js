import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let ghqResults: (string | null)[] = [];
let sessions: Array<{ name: string; windows?: unknown[] }> = [];
let resolved: { kind: string; match?: { name: string; windows?: unknown[] } } = { kind: "none" };
let config: { agents?: Record<string, string>; node?: string } = { node: "local-node" };
let listSessionsThrows = false;

const fleetDir = join(tmpdir(), `maw-locate-fleet-${process.pid}`);

mock.module("maw-js/core/ghq", () => ({
  ghqFind: async () => ghqResults.shift() ?? null,
}));
mock.module("maw-js/sdk", () => ({
  FLEET_DIR: fleetDir,
  listSessions: async () => {
    if (listSessionsThrows) throw new Error("tmux unavailable");
    return sessions;
  },
}));
mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleetEntries: () => readdirSync(fleetDir)
    .filter(file => file.endsWith(".json") && !file.endsWith(".disabled"))
    .sort()
    .map(file => {
      const match = file.match(/^(\d+)-(.+)\.json$/);
      return {
        file,
        path: join(fleetDir, file),
        num: match ? Number.parseInt(match[1], 10) : 0,
        groupName: match ? match[2] : file.replace(/\.json$/, ""),
        session: JSON.parse(readFileSync(join(fleetDir, file), "utf-8") || "{}"),
      };
    }),
}));
mock.module("maw-js/config", () => ({
  loadConfig: () => config,
}));
mock.module("maw-js/core/matcher/resolve-target", () => ({
  resolveSessionTarget: () => resolved,
}));

const { cmdLocate } = await import("../../src/vendor/mpr-plugins/locate/impl.ts?locate-impl-coverage");

const capture = async (fn: () => Promise<void>) => {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    await fn();
    return { logs, errors };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
};

describe("locate command implementation coverage", () => {
  let repoDir: string;

  beforeEach(() => {
    rmSync(fleetDir, { recursive: true, force: true });
    mkdirSync(fleetDir, { recursive: true });
    repoDir = mkdtempSync(join(tmpdir(), "maw-locate-repo-"));
    ghqResults = [];
    sessions = [];
    resolved = { kind: "none" };
    config = { node: "local-node" };
    listSessionsThrows = false;
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(fleetDir, { recursive: true, force: true });
  });

  test("requires an oracle name and prints usage to stderr", async () => {
    let thrown: Error | undefined;
    const output = await capture(async () => {
      try {
        await cmdLocate(undefined, {});
      } catch (e) {
        thrown = e as Error;
      }
    });

    expect(thrown?.message).toBe("missing oracle name");
    expect(output.errors.join("\n")).toContain("usage: maw locate <oracle> [--path | --json]");
  });

  test("throws not-found when repo, session, and fleet all miss", async () => {
    ghqResults = [null, null];

    await expect(cmdLocate("ghost", {})).rejects.toThrow("no oracle named 'ghost'");
  });

  test("prints JSON with repo, ψ presence, fleet config, session, and config agent node", async () => {
    mkdirSync(join(repoDir, "ψ"));
    writeFileSync(join(fleetDir, "77-mawjs.json"), JSON.stringify({ name: "77-mawjs" }), "utf-8");
    ghqResults = [repoDir];
    sessions = [{ name: "77-mawjs", windows: [{ name: "main" }, { name: "logs" }] }];
    resolved = { kind: "fuzzy", match: sessions[0] };
    config = { agents: { mawjs: "m5" }, node: "local-node" };

    const output = await capture(() => cmdLocate("mawjs", { json: true }));
    const parsed = JSON.parse(output.logs.join("\n"));

    expect(parsed).toMatchObject({
      name: "mawjs",
      repoPath: repoDir,
      hasPsi: true,
      sessionName: "77-mawjs",
      windowCount: 2,
      fleetConfigPath: join(fleetDir, "77-mawjs.json"),
      federationNode: "m5",
      inAgentsConfig: true,
    });
  });

  test("--path emits only the repo path and tolerates tmux failures", async () => {
    ghqResults = [null, repoDir];
    listSessionsThrows = true;

    const output = await capture(() => cmdLocate("bare", { path: true }));

    expect(output.logs).toEqual([repoDir]);
  });

  test("--path explains session/fleet context when no repo path exists", async () => {
    writeFileSync(join(fleetDir, "solo.json"), "{}", "utf-8");
    ghqResults = [null, null];
    sessions = [{ name: "solo", windows: [] }];
    resolved = { kind: "exact", match: sessions[0] };

    await expect(cmdLocate("solo", { path: true })).rejects.toThrow("no repo path for 'solo' (session: solo, fleet: yes)");
  });

  test("default output omits missing fields and labels this-node federation fallback", async () => {
    writeFileSync(join(fleetDir, "nodeonly-oracle.json"), "{}", "utf-8");
    ghqResults = [null, null];
    config = { node: "white" };

    const output = await capture(() => cmdLocate("nodeonly", {}));
    const text = output.logs.join("\n");

    expect(text).toContain("📍 nodeonly");
    expect(text).toContain(`fleet:    ${join(fleetDir, "nodeonly-oracle.json")}`);
    expect(text).toContain("node:     white (this node)");
    expect(text).not.toContain("repo:");
  });
});
