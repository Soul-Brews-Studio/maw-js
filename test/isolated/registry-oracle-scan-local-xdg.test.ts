import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const roots: string[] = [];

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `maw-registry-local-xdg-${label}-`));
  roots.push(dir);
  return dir;
}

function mkdirp(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function makeRepo(ghqRoot: string, org: string, repo: string): string {
  const repoDir = join(ghqRoot, "github.com", org, repo);
  mkdirp(repoDir);
  return repoDir;
}

afterEach(() => {
  while (roots.length) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("registry oracle local scan XDG fleet defaults", () => {
  test("lineage reads XDG state fleet first with legacy config fallback", async () => {
    const root = tmpRoot("state-first");
    const stateFleetDir = join(root, "state", "fleet");
    const configFleetDir = join(root, "config", "fleet");
    const ghqRoot = join(root, "ghq");
    const fleetDirs = [stateFleetDir, configFleetDir];

    mkdirp(stateFleetDir);
    mkdirp(configFleetDir);
    makeRepo(ghqRoot, "Org", "state-member");
    makeRepo(ghqRoot, "Org", "legacy-member");
    makeRepo(ghqRoot, "Org", "state-wins");

    writeJson(join(stateFleetDir, "10-state.json"), {
      project_repos: ["Org/state-member"],
      budded_from: "state-seed",
    });
    writeJson(join(configFleetDir, "20-legacy.json"), {
      project_repos: ["Org/legacy-member"],
      budded_from: "legacy-seed",
    });
    writeJson(join(stateFleetDir, "30-overlap.json"), {
      project_repos: ["Org/state-wins"],
      budded_from: "state-overlap",
    });
    writeJson(join(configFleetDir, "30-overlap.json"), {
      project_repos: ["Org/legacy-loses"],
      budded_from: "legacy-overlap",
    });

    const mod = await import("../../src/core/fleet/registry-oracle-scan-local.ts?registry-oracle-scan-local-xdg");
    const lineage = mod.readFleetLineage(fleetDirs);

    expect([...lineage.keys()].sort()).toEqual([
      "Org/legacy-member",
      "Org/state-member",
      "Org/state-wins",
    ]);
    expect(lineage.get("Org/state-member")).toMatchObject({ budded_from: "state-seed" });
    expect(lineage.get("Org/legacy-member")).toMatchObject({ budded_from: "legacy-seed" });
    expect(lineage.get("Org/state-wins")).toMatchObject({ budded_from: "state-overlap" });

    const entries = mod.scanLocal(false, {
      ghqRoot,
      config: { node: "m5", agents: {} },
      now: "2026-05-21T00:00:00.000Z",
      fleetDirs,
    });

    expect(entries.map(e => `${e.org}/${e.repo}`)).toEqual([
      "Org/legacy-member",
      "Org/state-member",
      "Org/state-wins",
    ]);
    expect(entries.find(e => e.repo === "state-member")).toMatchObject({
      has_fleet_config: true,
      budded_from: "state-seed",
      federation_node: "m5",
    });
  });
});
