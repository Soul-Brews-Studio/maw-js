import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let fleetEntries: Array<{ num: number; file: string; path?: string; session: { name: string } }> = [];
const fleetDir = join(tmpdir(), `maw-bud-init-fleet-${process.pid}`);

mock.module("maw-js/commands/shared/fleet-load", () => ({
  fleetDirForWrite: () => fleetDir,
  loadFleetEntries: () => fleetEntries,
}));

const { configureFleet, generateClaudeMd, initVault, writeBirthNote } = await import("../../src/vendor/mpr-plugins/bud/bud-init.ts?bud-init-coverage");

const captureLogs = (fn: () => unknown) => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    const result = fn();
    return { result, logs };
  } finally {
    console.log = origLog;
  }
};

describe("bud init helper coverage", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "maw-bud-init-"));
    rmSync(fleetDir, { recursive: true, force: true });
    mkdirSync(fleetDir, { recursive: true });
    fleetEntries = [];
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(fleetDir, { recursive: true, force: true });
  });

  test("initVault creates the ψ directory tree and writeBirthNote records root lineage", () => {
    const { result: psiDir, logs } = captureLogs(() => initVault(repoDir));

    expect(psiDir).toBe(join(repoDir, "ψ"));
    for (const rel of ["memory/learnings", "memory/retrospectives", "memory/traces", "memory/resonance", "memory/collaborations", "inbox", "outbox", "plans"]) {
      expect(existsSync(join(psiDir as string, rel))).toBe(true);
    }
    expect(logs.join("\n")).toContain("ψ/ vault initialized");

    captureLogs(() => writeBirthNote(psiDir as string, "sprout", null, "Needs a tiny garden."));
    const note = readFileSync(join(psiDir as string, "memory", "learnings", readdirSync(join(psiDir as string, "memory", "learnings"))[0]), "utf-8");
    expect(note).toContain("# Why sprout was born");
    expect(note).toContain("Root oracle — no parent");
  });

  test("generateClaudeMd writes parent/root variants and preserves existing files", () => {
    captureLogs(() => generateClaudeMd(repoDir, "leaf", "mawjs"));
    const claude = join(repoDir, "CLAUDE.md");
    const first = readFileSync(claude, "utf-8");
    expect(first).toContain("# leaf-oracle");
    expect(first).toContain("Budded from **mawjs**");
    expect(first).toContain("**Budded from**: mawjs");
    expect(first).toContain("## Inbox Discipline");
    expect(first).toContain("maw inbox read <id>");

    writeFileSync(claude, "keep me", "utf-8");
    captureLogs(() => generateClaudeMd(repoDir, "leaf", null));
    expect(readFileSync(claude, "utf-8")).toBe("keep me");

    const rootRepo = mkdtempSync(join(tmpdir(), "maw-bud-root-"));
    try {
      captureLogs(() => generateClaudeMd(rootRepo, "rooty", null));
      const rootText = readFileSync(join(rootRepo, "CLAUDE.md"), "utf-8");
      expect(rootText).toContain("Root oracle — born");
      expect(rootText).toContain("**Origin**: root (no parent)");
    } finally {
      rmSync(rootRepo, { recursive: true, force: true });
    }
  });

  test("configureFleet creates new numbered configs with lineage", () => {
    fleetEntries = [{ num: 7, file: "07-parent.json", session: { name: "07-parent" } }];

    const { result: fleetFile, logs } = captureLogs(() => configureFleet("leaf", "Soul-Brews-Studio", "leaf-oracle", "mawjs"));
    const cfg = JSON.parse(readFileSync(fleetFile as string, "utf-8"));

    expect(fleetFile).toBe(join(fleetDir, "08-leaf.json"));
    expect(cfg).toMatchObject({
      name: "08-leaf",
      windows: [{ name: "leaf-oracle", repo: "Soul-Brews-Studio/leaf-oracle" }],
      sync_peers: ["mawjs"],
      budded_from: "mawjs",
    });
    expect(typeof cfg.budded_at).toBe("string");
    expect(logs.join("\n")).toContain("fleet config:");
  });

  test("configureFleet updates existing lineage or reports existing config", () => {
    const file = join(fleetDir, "12-leaf.json");
    writeFileSync(file, JSON.stringify({ name: "12-leaf", windows: [] }), "utf-8");
    fleetEntries = [{ num: 12, file: "12-leaf.json", session: { name: "12-leaf" } }];

    const updated = captureLogs(() => configureFleet("leaf", "org", "repo", "mawjs"));
    expect(updated.result).toBe(file);
    let cfg = JSON.parse(readFileSync(file, "utf-8"));
    expect(cfg.budded_from).toBe("mawjs");
    expect(updated.logs.join("\n")).toContain("fleet config updated with lineage");

    const existed = captureLogs(() => configureFleet("leaf", "org", "repo", "mawjs"));
    cfg = JSON.parse(readFileSync(file, "utf-8"));
    expect(cfg.budded_from).toBe("mawjs");
    expect(existed.logs.join("\n")).toContain("fleet config exists");
  });

  test("configureFleet updates the loaded source path for migrated fleet entries", () => {
    const stateFleetDir = mkdtempSync(join(tmpdir(), "maw-bud-init-state-fleet-"));
    try {
      const stateFile = join(stateFleetDir, "12-leaf.json");
      const legacyFile = join(fleetDir, "12-leaf.json");
      writeFileSync(stateFile, JSON.stringify({ name: "12-leaf", windows: [] }), "utf-8");
      fleetEntries = [{ num: 12, file: "12-leaf.json", path: stateFile, session: { name: "12-leaf" } }];

      const updated = captureLogs(() => configureFleet("leaf", "org", "repo", "mawjs"));

      expect(updated.result).toBe(stateFile);
      expect(JSON.parse(readFileSync(stateFile, "utf-8")).budded_from).toBe("mawjs");
      expect(existsSync(legacyFile)).toBe(false);
    } finally {
      rmSync(stateFleetDir, { recursive: true, force: true });
    }
  });
});
