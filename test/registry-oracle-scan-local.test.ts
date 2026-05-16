import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { deriveName, readFleetLineage, scanLocal } from "../src/core/fleet/registry-oracle-scan-local";

const roots: string[] = [];

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `maw-local-scan-${label}-`));
  roots.push(dir);
  return dir;
}

function mkdirp(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function makeRepo(ghqRoot: string, org: string, repo: string, opts: { psi?: boolean } = {}): string {
  const repoDir = join(ghqRoot, "github.com", org, repo);
  mkdirp(repoDir);
  if (opts.psi) mkdirp(join(repoDir, "ψ"));
  return repoDir;
}

afterEach(() => {
  while (roots.length) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("registry-oracle-scan-local", () => {
  test("readFleetLineage merges project_repos and window repo references while skipping invalid files", () => {
    const root = tmpRoot("lineage");
    const fleetDir = join(root, "fleet");
    mkdirp(fleetDir);
    writeJson(join(fleetDir, "alpha.json"), {
      project_repos: ["Soul-Brews-Studio/mawjs-oracle", "Soul-Brews-Studio/fleet-only-oracle"],
      windows: [
        { name: "mawjs", repo: "Soul-Brews-Studio/mawjs-oracle" },
        { name: "issuer", repo: "Soul-Brews-Studio/mawjs-issuer-oracle" },
      ],
      budded_from: "seed-oracle",
      budded_at: "2026-05-16T00:00:00.000Z",
    });
    writeFileSync(join(fleetDir, "broken.json"), "{ nope");
    writeJson(join(fleetDir, "ignored.json.disabled"), {
      project_repos: ["Soul-Brews-Studio/ignored-oracle"],
    });

    const lineage = readFleetLineage(fleetDir);

    expect([...lineage.keys()].sort()).toEqual([
      "Soul-Brews-Studio/fleet-only-oracle",
      "Soul-Brews-Studio/mawjs-issuer-oracle",
      "Soul-Brews-Studio/mawjs-oracle",
    ]);
    expect(lineage.get("Soul-Brews-Studio/mawjs-issuer-oracle")).toMatchObject({
      budded_from: "seed-oracle",
      budded_at: "2026-05-16T00:00:00.000Z",
    });
    expect(readFleetLineage(join(root, "missing")).size).toBe(0);
  });

  test("deriveName removes only the canonical -oracle suffix", () => {
    expect(deriveName("mawjs-oracle")).toBe("mawjs");
    expect(deriveName("mawjs-issuer")).toBe("mawjs-issuer");
  });

  test("scanLocal detects ψ dirs, fleet lineage, -oracle suffixes, fleet-only refs, and federation nodes", () => {
    const root = tmpRoot("scan");
    const ghqRoot = join(root, "ghq");
    const fleetDir = join(root, "fleet");
    mkdirp(fleetDir);
    mkdirp(join(ghqRoot, "github.com", "Soul-Brews-Studio"));
    writeFileSync(join(ghqRoot, "github.com", "not-an-org"), "file");
    writeFileSync(join(ghqRoot, "github.com", "Soul-Brews-Studio", "not-a-repo"), "file");

    const psiDir = makeRepo(ghqRoot, "Soul-Brews-Studio", "psi-oracle", { psi: true });
    const fleetDirRepo = makeRepo(ghqRoot, "Soul-Brews-Studio", "fleet-member");
    const suffixDir = makeRepo(ghqRoot, "Soul-Brews-Studio", "suffix-oracle");
    makeRepo(ghqRoot, "Soul-Brews-Studio", "plain-repo");
    makeRepo(ghqRoot, "Other", "zeta-oracle");

    writeJson(join(fleetDir, "fleet.json"), {
      project_repos: ["Soul-Brews-Studio/fleet-member", "Missing/remote-oracle"],
      windows: [{ name: "psi", repo: "Soul-Brews-Studio/psi-oracle" }],
      budded_from: "root-oracle",
      budded_at: "2026-05-16T01:02:03.000Z",
    });

    const entries = scanLocal(false, {
      ghqRoot,
      fleetDir,
      now: "2026-05-16T04:05:06.000Z",
      config: { node: "m5", agents: { "fleet-member": "m6" } },
    });

    expect(entries.map(e => `${e.org}/${e.repo}`)).toEqual([
      "Missing/remote-oracle",
      "Other/zeta-oracle",
      "Soul-Brews-Studio/fleet-member",
      "Soul-Brews-Studio/psi-oracle",
      "Soul-Brews-Studio/suffix-oracle",
    ]);
    expect(entries.find(e => e.repo === "plain-repo")).toBeUndefined();
    expect(entries.find(e => e.repo === "psi-oracle")).toMatchObject({
      name: "psi",
      local_path: psiDir,
      has_psi: true,
      has_fleet_config: true,
      budded_from: "root-oracle",
      federation_node: "m5",
      detected_at: "2026-05-16T04:05:06.000Z",
    });
    expect(entries.find(e => e.repo === "fleet-member")).toMatchObject({
      name: "fleet-member",
      local_path: fleetDirRepo,
      has_psi: false,
      has_fleet_config: true,
      federation_node: "m6",
    });
    expect(entries.find(e => e.repo === "suffix-oracle")).toMatchObject({
      name: "suffix",
      local_path: suffixDir,
      has_psi: false,
      has_fleet_config: false,
      federation_node: "m5",
    });
    expect(entries.find(e => e.repo === "remote-oracle")).toMatchObject({
      name: "remote",
      local_path: "",
      has_psi: false,
      has_fleet_config: true,
      federation_node: null,
    });
  });

  test("scanLocal verbose mode reports scan sources, fleet-only refs, enrichment, and walk failures", () => {
    const root = tmpRoot("verbose");
    const ghqRoot = join(root, "ghq");
    const fleetDir = join(root, "fleet");
    mkdirp(fleetDir);
    makeRepo(ghqRoot, "Soul-Brews-Studio", "mawjs-oracle", { psi: true });
    writeJson(join(fleetDir, "fleet.json"), {
      project_repos: ["Missing/remote-oracle"],
    });

    const logs: string[] = [];
    const warnings: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => logs.push(args.map(String).join(" ")));
    const warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => warnings.push(args.map(String).join(" ")));
    try {
      scanLocal(true, {
        ghqRoot,
        fleetDir,
        config: { node: "m5", agents: { mawjs: "m5-agent" } },
        now: "2026-05-16T04:05:06.000Z",
      });
      scanLocal(true, {
        ghqRoot: join(root, "missing-ghq"),
        fleetDir,
        config: { node: "m5", agents: {} },
        fleetLineage: new Map(),
      });
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(logs.some(line => line.includes("scanning repos root:"))).toBe(true);
    expect(logs.some(line => line.includes("fleet lineage: 1 entries"))).toBe(true);
    expect(logs.some(line => line.includes("Soul-Brews-Studio/mawjs-oracle"))).toBe(true);
    expect(logs.some(line => line.includes("federation-enriched 1"))).toBe(true);
    expect(logs.some(line => line.includes("fleet-only oracles"))).toBe(true);
    expect(warnings.some(line => line.includes("failed to walk repos root"))).toBe(true);
  });
});
