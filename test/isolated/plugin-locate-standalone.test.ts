import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
let repoPath = "";
let psiExists = true;
let sessions: Array<{ name: string; windows: Array<{ index: number; name: string }> }> = [];
let fleetEntries: any[] = [];
let config: any = {};
let manifest: any[] = [];
let federationHits: any[] = [];

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  ghqFind: async (pattern: string) => {
    if (pattern.includes("mawjs-oracle") || pattern.includes("mawjs")) return repoPath;
    return null;
  },
  listSessions: async () => sessions,
  loadFleetEntries: () => fleetEntries,
  loadConfig: () => config,
  loadManifestCached: () => manifest,
  resolveSessionTarget: (oracle: string, available: typeof sessions) => {
    const match = available.find((session) => session.name === `139-${oracle}` || session.name === oracle);
    return match ? { kind: "exact", match } : { kind: "none" };
  },
  parseFlags: (args: string[], spec: Record<string, unknown>) => {
    const out: Record<string, any> = { _: [] };
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      const parser = spec[arg];
      if (!parser) out._.push(arg);
      else if (parser === Boolean) out[arg] = true;
      else if (typeof parser === "string") out[parser] = true;
      else out[arg] = args[++i];
    }
    return out;
  },
  UserError: class UserError extends Error {},
}));

mock.module("../../src/vendor/mpr-plugins/ls/internal/peer-resolve.ts", () => ({
  resolveAllPeers: () => federationHits.map((hit) => ({ alias: hit.alias, url: hit.url, node: hit.node ?? null })),
}));

mock.module("../../src/vendor/mpr-plugins/ls/internal/peer-call.ts", () => ({
  fetchPeerPayload: async (peer: any) => federationHits.find((hit) => hit.alias === peer.alias)?.payload ?? { sessions: [] },
}));

const { default: locateHandler } = await import("../../src/vendor/mpr-plugins/locate/index.ts?plugin-locate-standalone");
const { cmdLocate } = await import("../../src/vendor/mpr-plugins/locate/impl.ts?plugin-locate-standalone");

beforeEach(() => {
  repoPath = join(tmpdir(), `maw-locate-${Date.now()}-${Math.random().toString(36).slice(2)}`, "mawjs-oracle");
  rmSync(repoPath.replace(/\/mawjs-oracle$/, ""), { recursive: true, force: true });
  mkdirSync(join(repoPath, "ψ"), { recursive: true });
  psiExists = true;
  sessions = [{ name: "139-mawjs", windows: [{ index: 1, name: "mawjs-oracle" }, { index: 2, name: "work" }] }];
  fleetEntries = [{ file: "139-mawjs.json", path: "/fleet/139-mawjs.json", session: { name: "139-mawjs" }, groupName: "mawjs" }];
  config = { node: "local-node", agents: { mawjs: "remote-node" } };
  manifest = [{ name: "mawjs", localPath: repoPath, hasPsi: true, sources: ["registry"], node: "manifest-node" }];
  federationHits = [{
    alias: "white",
    node: "white-node",
    url: "http://white.local",
    payload: { alias: "white", node: "white-node", url: "http://white.local", sessions: [{ name: "mawjs", windows: [{ name: "mawjs-oracle" }] }] },
  }];
});

describe("locate plugin standalone boundary (#2113)", () => {
  test("imports runtime dependencies through SDK plus plugin-local ls helpers", () => {
    for (const rel of ["index.ts", "impl.ts"]) {
      const source = readFileSync(join(root, "src/vendor/mpr-plugins/locate", rel), "utf8");
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib|plugin)(?:\/|")/);
    }
    const impl = readFileSync(join(root, "src/vendor/mpr-plugins/locate/impl.ts"), "utf8");
    expect(impl).toContain('from "maw-js/sdk"');
    expect(impl).toContain('from "../ls/internal/peer-call"');
    expect(impl).toContain('from "../ls/internal/peer-resolve"');
  });

  test("handler renders locate summary from SDK data and peer helpers", async () => {
    const result = await locateHandler({ source: "cli", args: ["mawjs"] } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("📍 mawjs");
    expect(result.output).toContain(`repo:     ${repoPath}`);
    expect(result.output).toContain("ψ/:       present");
    expect(result.output).toContain("session:  139-mawjs (2 windows)");
    expect(result.output).toContain("fleet:    /fleet/139-mawjs.json");
    expect(result.output).toContain("node:     remote-node (from config.agents)");
    expect(result.output).toContain("remote:   white-node:mawjs (http://white.local) (1 window)");
  });

  test("path and json modes stay shell/API friendly", async () => {
    const pathResult = await locateHandler({ source: "cli", args: ["mawjs", "--path"] } as any);
    expect(pathResult).toEqual({ ok: true, output: repoPath });

    const jsonResult = await locateHandler({ source: "cli", args: ["mawjs", "--json"] } as any);
    expect(jsonResult.ok).toBe(true);
    expect(JSON.parse(jsonResult.output!)).toMatchObject({
      name: "mawjs",
      repoPath,
      hasPsi: true,
      sessionName: "139-mawjs",
      windowCount: 2,
    });
  });

  test("reports missing oracle and missing repo path through UserError messages", async () => {
    repoPath = "";
    sessions = [];
    fleetEntries = [];
    manifest = [];
    federationHits = [];
    const missing = await locateHandler({ source: "cli", args: ["ghost"] } as any);
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("no oracle named 'ghost'");

    sessions = [{ name: "ghost", windows: [] }];
    const noPathLogs: string[] = [];
    const orig = console.log;
    console.log = (...args: any[]) => noPathLogs.push(args.map(String).join(" "));
    try {
      await expect(cmdLocate("ghost", { path: true })).rejects.toThrow("no repo path for 'ghost'");
    } finally {
      console.log = orig;
    }
  });
});
