import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let ghqResults: (string | null)[] = [];
let sessions: Array<{ name: string; windows?: unknown[] }> = [];
let resolved: { kind: string; match?: { name: string; windows?: unknown[] } } = { kind: "none" };
let config: { agents?: Record<string, string>; node?: string } = { node: "local-node" };
let listSessionsThrows = false;
let curlFetchCalls: Array<{ url: string; options: any }> = [];
let curlFetchQueue: any[] = [];
let manifestEntries: any[] = [];
let originalPeersFile: string | undefined;

const fleetDir = join(tmpdir(), `maw-locate-fleet-${process.pid}`);
const peersFile = join(tmpdir(), `maw-locate-peers-${process.pid}.json`);

mock.module("maw-js/core/ghq", () => ({
  ghqFind: async () => ghqResults.shift() ?? null,
}));
mock.module("maw-js/sdk", () => ({
  FLEET_DIR: fleetDir,
  ghqFind: async () => ghqResults.shift() ?? null,
  listSessions: async () => {
    if (listSessionsThrows) throw new Error("tmux unavailable");
    return sessions;
  },
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
  loadConfig: () => config,
  resolveSessionTarget: () => resolved,
  loadManifestCached: () => manifestEntries,
  curlFetch: async (url: string, options: any) => {
    curlFetchCalls.push({ url, options });
    return curlFetchQueue.shift() ?? { ok: true, status: 200, data: { sessions: [] } };
  },
  UserError: class UserError extends Error {},
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
mock.module("maw-js/lib/oracle-manifest", () => ({
  loadManifestCached: () => manifestEntries,
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
    originalPeersFile = process.env.PEERS_FILE;
    process.env.PEERS_FILE = peersFile;
    writeFileSync(peersFile, JSON.stringify({ peers: {} }), "utf-8");
    rmSync(fleetDir, { recursive: true, force: true });
    mkdirSync(fleetDir, { recursive: true });
    repoDir = mkdtempSync(join(tmpdir(), "maw-locate-repo-"));
    ghqResults = [];
    sessions = [];
    resolved = { kind: "none" };
    config = { node: "local-node" };
    listSessionsThrows = false;
    curlFetchCalls = [];
    curlFetchQueue = [];
    manifestEntries = [];
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(fleetDir, { recursive: true, force: true });
    rmSync(peersFile, { force: true });
    if (originalPeersFile === undefined) delete process.env.PEERS_FILE;
    else process.env.PEERS_FILE = originalPeersFile;
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

  test("scans federation peers and reports matching remote sessions", async () => {
    ghqResults = [null, null];
    writeFileSync(peersFile, JSON.stringify({
      peers: { alpha: { url: "http://alpha.wg:3461", node: "alpha" } },
    }), "utf-8");
    curlFetchQueue = [{
      ok: true,
      status: 200,
      data: {
        alias: "alpha",
        node: "alpha",
        url: "http://alpha.wg:3461",
        sessions: [
          { name: "05-volt", windows: [{ index: 1, name: "volt-oracle", active: true }] },
          { name: "09-other", windows: [] },
        ],
      },
    }];

    const output = await capture(() => cmdLocate("volt", {}));
    const text = output.logs.join("\n");

    expect(curlFetchCalls[0]?.url).toBe("http://alpha.wg:3461/api/ls");
    expect(text).toContain("remote:   alpha:05-volt (http://alpha.wg:3461) (1 window)");
  });

  test("json mode includes federation hits", async () => {
    ghqResults = [null, null];
    writeFileSync(peersFile, JSON.stringify({
      peers: { alpha: { url: "http://alpha.wg:3461", node: "alpha" } },
    }), "utf-8");
    curlFetchQueue = [{
      ok: true,
      status: 200,
      data: { sessions: [{ name: "05-volt", windows: [{ index: 1, name: "volt-oracle" }] }] },
    }];

    const output = await capture(() => cmdLocate("volt", { json: true }));
    const parsed = JSON.parse(output.logs.join("\n"));

    expect(parsed.federation).toEqual([{
      alias: "alpha",
      node: "alpha",
      url: "http://alpha.wg:3461",
      sessionName: "05-volt",
      windowCount: 1,
    }]);
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

  test("falls back to manifest-only oracle records and labels manifest node", async () => {
    ghqResults = [null, null];
    manifestEntries = [{
      name: "mira",
      sources: ["oracles-json"],
      node: "sgp1",
      repo: "Soul-Brews-Studio/mira-oracle",
      localPath: "/opt/Code/github.com/Soul-Brews-Studio/mira-oracle",
      hasPsi: true,
      hasFleetConfig: true,
      isLive: false,
    }];

    const output = await capture(() => cmdLocate("mira", { json: true }));
    const parsed = JSON.parse(output.logs.join("\n"));

    expect(parsed).toMatchObject({
      name: "mira",
      repoPath: "/opt/Code/github.com/Soul-Brews-Studio/mira-oracle",
      hasPsi: true,
      federationNode: "sgp1",
      manifestEntry: {
        name: "mira",
        node: "sgp1",
      },
    });

    const human = await capture(() => cmdLocate("mira", {}));
    const text = human.logs.join("\n");
    expect(text).toContain("source:   oracles-json");
    expect(text).toContain("node:     sgp1 (from manifest)");
    expect(text).toContain("fleet:    known (manifest)");
  });

  test("prefers a live local session node over stale manifest node metadata", async () => {
    ghqResults = [null, null];
    sessions = [{ name: "77-mawjs", windows: [{ name: "main" }] }];
    resolved = { kind: "exact", match: sessions[0] };
    config = { node: "m5" };
    manifestEntries = [{
      name: "mawjs",
      sources: ["oracles-json"],
      node: "stale-remote",
      isLive: false,
    }];

    const output = await capture(() => cmdLocate("mawjs", {}));
    const text = output.logs.join("\n");

    expect(text).toContain("session:  77-mawjs (1 window)");
    expect(text).toContain("node:     m5 (this node)");
    expect(text).not.toContain("stale-remote");
  });
});
