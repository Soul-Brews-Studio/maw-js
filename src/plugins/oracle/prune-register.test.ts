import { describe, it, expect } from "bun:test";
import {
  buildPruneCandidates,
  buildStaleCandidates,
  runPrune,
  cmdOraclePrune,
  listAwakeOracles,
  readRawRegistry as readPruneRawRegistry,
  writeRawRegistry as writePruneRawRegistry,
} from "./impl-prune";
import {
  findInFleet,
  findInFilesystem,
  findInTmux,
  cmdOracleRegister,
  readRawRegistry as readRegisterRawRegistry,
  writeRawRegistry as writeRegisterRawRegistry,
} from "./impl-register";
import type { OracleEntry } from "../../../sdk";
import type { StaleEntry } from "./impl-stale";
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function entry(partial: Partial<OracleEntry> = {}): OracleEntry {
  return {
    org: "Soul-Brews-Studio",
    repo: "test-oracle",
    name: "test",
    local_path: "/tmp/test-oracle",
    has_psi: true,
    has_fleet_config: true,
    budded_from: "neo",
    budded_at: "2026-01-01T00:00:00Z",
    federation_node: "white",
    detected_at: "2026-04-17T00:00:00Z",
    ...partial,
  };
}

function orphan(name: string): OracleEntry {
  return entry({
    name,
    repo: `${name}-oracle`,
    has_psi: false,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
  });
}

function staleEntry(name: string, tier: "STALE" | "DEAD"): StaleEntry {
  return {
    name,
    org: "Soul-Brews-Studio",
    repo: `${name}-oracle`,
    local_path: `/tmp/${name}`,
    has_psi: false,
    awake: false,
    last_commit: null,
    days_since_commit: tier === "DEAD" ? 120 : 60,
    tier,
    recommendation: tier === "DEAD" ? "prune candidate (no ψ/)" : "investigate",
  };
}


// ─── Raw registry helpers ───────────────────────────────────────────────────

describe("oracle raw registry helpers", () => {
  it("reads existing JSON and falls back to empty object for missing or invalid files", () => {
    const dir = mkdtempSync(join(tmpdir(), "oracle-raw-"));
    const valid = join(dir, "valid.json");
    const invalid = join(dir, "invalid.json");
    writeFileSync(valid, JSON.stringify({ oracles: [orphan("ghost")] }));
    writeFileSync(invalid, "{ nope");

    expect(readPruneRawRegistry(valid)).toEqual({ oracles: [orphan("ghost")] });
    expect(readPruneRawRegistry(join(dir, "missing.json"))).toEqual({});
    expect(readPruneRawRegistry(invalid)).toEqual({});
    expect(readRegisterRawRegistry(valid)).toEqual({ oracles: [orphan("ghost")] });
    expect(readRegisterRawRegistry(invalid)).toEqual({});
  });

  it("writes pretty newline-terminated registry JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "oracle-write-"));
    const pruneFile = join(dir, "prune.json");
    const registerFile = join(dir, "register.json");

    writePruneRawRegistry(pruneFile, { oracles: [orphan("prune")] });
    writeRegisterRawRegistry(registerFile, { oracles: [orphan("register")] });

    expect(readFileSync(pruneFile, "utf-8").endsWith("\n")).toBe(true);
    expect(JSON.parse(readFileSync(pruneFile, "utf-8")).oracles[0].name).toBe("prune");
    expect(readFileSync(registerFile, "utf-8").endsWith("\n")).toBe(true);
    expect(JSON.parse(readFileSync(registerFile, "utf-8")).oracles[0].name).toBe("register");
  });
});

// ─── listAwakeOracles ───────────────────────────────────────────────────────

describe("listAwakeOracles", () => {
  it("extracts oracle window names and ignores non-oracle windows", async () => {
    const awake = await listAwakeOracles(async () => [
      { name: "main", windows: [{ name: "neo-oracle" }, { name: "notes" }] },
      { name: "other", windows: [{ name: "mawjs-oracle" }] },
    ] as any);

    expect([...awake].sort()).toEqual(["mawjs", "neo"]);
  });

  it("returns an empty set when tmux listing fails", async () => {
    const awake = await listAwakeOracles(async () => { throw new Error("tmux unavailable"); });
    expect([...awake]).toEqual([]);
  });
});

// ─── buildPruneCandidates ─────────────────────────────────────────────────────

describe("buildPruneCandidates", () => {
  it("marks orphan entry (no signals) as candidate", () => {
    const candidates = buildPruneCandidates([orphan("ghost")], new Set());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].entry.name).toBe("ghost");
    expect(candidates[0].reasons).toContain("empty lineage");
    expect(candidates[0].reasons).toContain("no tmux");
    expect(candidates[0].reasons).toContain("no federation");
  });

  it("excludes oracle with federation_node", () => {
    const e = orphan("federated");
    e.federation_node = "white";
    const candidates = buildPruneCandidates([e], new Set());
    expect(candidates).toHaveLength(0);
  });

  it("excludes oracle that is awake in tmux", () => {
    const candidates = buildPruneCandidates([orphan("active")], new Set(["active"]));
    expect(candidates).toHaveLength(0);
  });

  it("excludes oracle with ψ/ (has_psi = true)", () => {
    const e = orphan("psi-holder");
    e.has_psi = true;
    // has_psi breaks "empty lineage" → not a candidate
    const candidates = buildPruneCandidates([e], new Set());
    expect(candidates).toHaveLength(0);
  });

  it("excludes oracle with fleet config", () => {
    const e = orphan("fleet-member");
    e.has_fleet_config = true;
    const candidates = buildPruneCandidates([e], new Set());
    expect(candidates).toHaveLength(0);
  });

  it("excludes oracle with budded_from lineage", () => {
    const e = orphan("budded");
    e.budded_from = "neo";
    const candidates = buildPruneCandidates([e], new Set());
    expect(candidates).toHaveLength(0);
  });

  it("includes 'not cloned' reason when local_path is empty", () => {
    const e = orphan("ghost");
    e.local_path = "";
    const candidates = buildPruneCandidates([e], new Set());
    expect(candidates[0].reasons).toContain("not cloned");
  });

  it("handles mixed list — only orphans become candidates", () => {
    const entries = [
      entry({ name: "healthy" }),   // has all signals
      orphan("ghost"),              // no signals → candidate
    ];
    const candidates = buildPruneCandidates(entries, new Set(["healthy"]));
    expect(candidates.map((c) => c.entry.name)).toEqual(["ghost"]);
  });
});

// ─── buildStaleCandidates ─────────────────────────────────────────────────────

describe("buildStaleCandidates", () => {
  it("includes STALE and DEAD tiers only", () => {
    const stale = [
      { ...staleEntry("active", "STALE"), tier: "ACTIVE" as any },
      staleEntry("rotting", "STALE"),
      staleEntry("dead", "DEAD"),
    ];
    const candidates = buildStaleCandidates(stale);
    expect(candidates.map((c) => c.entry.name)).toEqual(["rotting", "dead"]);
  });

  it("carries tier through to candidate", () => {
    const candidates = buildStaleCandidates([staleEntry("dusty", "STALE")]);
    expect(candidates[0].tier).toBe("STALE");
  });

  it("includes tier as reason", () => {
    const dead = buildStaleCandidates([staleEntry("ghost", "DEAD")]);
    expect(dead[0].reasons.some((r) => r.includes("DEAD"))).toBe(true);

    const stale = buildStaleCandidates([staleEntry("dusty", "STALE")]);
    expect(stale[0].reasons.some((r) => r.includes("STALE"))).toBe(true);
  });
});

// ─── runPrune (dry-run) ───────────────────────────────────────────────────────

describe("runPrune — dry-run (no --force)", () => {
  it("returns candidates without writing", async () => {
    let written = false;
    const candidates = await runPrune(
      {},
      {
        readEntries: () => [orphan("ghost")],
        listAwake: async () => new Set(),
        readRawCache: () => ({ oracles: [orphan("ghost")] }),
        writeRawCache: () => { written = true; },
      },
    );
    expect(candidates).toHaveLength(1);
    expect(written).toBe(false);
  });

  it("returns empty candidates for healthy registry", async () => {
    const candidates = await runPrune(
      {},
      {
        readEntries: () => [entry({ name: "healthy" })],
        listAwake: async () => new Set(["healthy"]),
        readRawCache: () => ({ oracles: [entry({ name: "healthy" })] }),
        writeRawCache: () => {},
      },
    );
    expect(candidates).toHaveLength(0);
  });
});

// ─── runPrune --stale filter ──────────────────────────────────────────────────

describe("runPrune --stale", () => {
  it("delegates to stale classifier", async () => {
    let calledStale = false;
    const candidates = await runPrune(
      { stale: true },
      {
        runStale: async () => {
          calledStale = true;
          return [staleEntry("dusty", "STALE")];
        },
        readRawCache: () => ({ oracles: [] }),
        writeRawCache: () => {},
      },
    );
    expect(calledStale).toBe(true);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].entry.name).toBe("dusty");
  });

  it("excludes ACTIVE and SLOW tiers", async () => {
    const candidates = await runPrune(
      { stale: true },
      {
        runStale: async () => [
          { ...staleEntry("fast", "STALE"), tier: "ACTIVE" as any },
          { ...staleEntry("slow", "STALE"), tier: "SLOW" as any },
          staleEntry("dead-one", "DEAD"),
        ],
        readRawCache: () => ({ oracles: [] }),
        writeRawCache: () => {},
      },
    );
    expect(candidates.map((c) => c.entry.name)).toEqual(["dead-one"]);
  });
});


// ─── cmdOraclePrune output modes ────────────────────────────────────────────

describe("cmdOraclePrune output modes", () => {
  it("prints JSON candidates without retiring", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: unknown) => { logs.push(String(msg)); };
    try {
      await cmdOraclePrune(
        { json: true },
        {
          listAwake: async () => new Set(),
          readRawCache: () => ({ oracles: [orphan("ghost")] }),
          writeRawCache: () => { throw new Error("should not write JSON dry-run"); },
        },
      );
    } finally {
      console.log = originalLog;
    }

    const payload = JSON.parse(logs[0]);
    expect(payload).toMatchObject({ schema: 1, count: 1, dry_run: true });
    expect(payload.candidates[0].entry.name).toBe("ghost");
  });

  it("prints dry-run guidance and does not prompt", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: unknown) => { logs.push(String(msg)); };
    try {
      await cmdOraclePrune(
        {},
        {
          listAwake: async () => new Set(),
          readRawCache: () => ({ oracles: [orphan("ghost")] }),
          writeRawCache: () => { throw new Error("dry-run should not write"); },
          promptConfirm: async () => { throw new Error("dry-run should not prompt"); },
        },
      );
    } finally {
      console.log = originalLog;
    }

    expect(logs.join("\n")).toContain("--force");
  });
});

// ─── cmdOraclePrune --force confirm flow ─────────────────────────────────────

describe("cmdOraclePrune --force", () => {
  it("retires candidates when user confirms", async () => {
    const initial = [orphan("ghost"), entry({ name: "healthy", federation_node: "white" })];
    let written: Record<string, unknown> | null = null;

    await cmdOraclePrune(
      { force: true },
      {
        readEntries: () => initial,
        listAwake: async () => new Set(),
        readRawCache: () => ({ oracles: initial }),
        writeRawCache: (data) => { written = data; },
        promptConfirm: async () => true,
      },
    );

    expect(written).not.toBeNull();
    const oracles = written!.oracles as OracleEntry[];
    expect(oracles.map((e) => e.name)).not.toContain("ghost");
    expect(oracles.map((e) => e.name)).toContain("healthy");

    const retired = written!.retired as any[];
    expect(retired).toHaveLength(1);
    expect(retired[0].name).toBe("ghost");
    expect(retired[0].retired_at).toBeTruthy();
    expect(retired[0].retired_reasons).toContain("empty lineage");
  });

  it("aborts when user denies confirmation", async () => {
    let written = false;
    await cmdOraclePrune(
      { force: true },
      {
        readEntries: () => [orphan("ghost")],
        listAwake: async () => new Set(),
        readRawCache: () => ({ oracles: [orphan("ghost")] }),
        writeRawCache: () => { written = true; },
        promptConfirm: async () => false,
      },
    );
    expect(written).toBe(false);
  });

  it("preserves existing retired entries", async () => {
    const existingRetired = [{ name: "old", retired_at: "2026-01-01T00:00:00Z", retired_reasons: [] }];
    let written: Record<string, unknown> | null = null;

    await cmdOraclePrune(
      { force: true },
      {
        readEntries: () => [orphan("ghost")],
        listAwake: async () => new Set(),
        readRawCache: () => ({ oracles: [orphan("ghost")], retired: existingRetired }),
        writeRawCache: (data) => { written = data; },
        promptConfirm: async () => true,
      },
    );

    const retired = written!.retired as any[];
    expect(retired).toHaveLength(2);
    expect(retired.map((r) => r.name)).toContain("old");
    expect(retired.map((r) => r.name)).toContain("ghost");
  });

  it("does not write when no candidates exist", async () => {
    let written = false;
    await cmdOraclePrune(
      { force: true },
      {
        readEntries: () => [entry({ name: "healthy", federation_node: "white" })],
        listAwake: async () => new Set(["healthy"]),
        readRawCache: () => ({ oracles: [entry({ name: "healthy", federation_node: "white" })] }),
        writeRawCache: () => { written = true; },
        promptConfirm: async () => true,
      },
    );
    expect(written).toBe(false);
  });
});

// ─── findInFleet ─────────────────────────────────────────────────────────────

describe("findInFleet", () => {
  it("finds oracle in fleet config by window name", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-"));
    writeFileSync(
      join(dir, "mawjs.json"),
      JSON.stringify({
        windows: [{ name: "mawjs-oracle" }],
        project_repos: ["Soul-Brews-Studio/mawjs-oracle"],
        budded_from: "neo",
        budded_at: "2026-04-07T00:00:00Z",
      }),
    );
    const result = findInFleet("mawjs", dir);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("fleet");
    expect(result!.entry.name).toBe("mawjs");
    expect(result!.entry.org).toBe("Soul-Brews-Studio");
    expect(result!.entry.has_fleet_config).toBe(true);
    expect(result!.entry.budded_from).toBe("neo");
  });

  it("returns null if oracle not found in fleet", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-"));
    writeFileSync(join(dir, "other.json"), JSON.stringify({ windows: [{ name: "other-oracle" }] }));
    expect(findInFleet("mawjs", dir)).toBeNull();
  });

  it("returns null for empty fleet dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-"));
    expect(findInFleet("mawjs", dir)).toBeNull();
  });
});

// ─── findInFilesystem ─────────────────────────────────────────────────────────

describe("findInFilesystem", () => {
  it("finds oracle by -oracle repo name with ψ/", () => {
    const root = mkdtempSync(join(tmpdir(), "ghq-"));
    const org = join(root, "Soul-Brews-Studio");
    const repo = join(org, "newbie-oracle");
    mkdirSync(join(repo, "ψ"), { recursive: true });
    const result = findInFilesystem("newbie", root);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("filesystem");
    expect(result!.entry.name).toBe("newbie");
    expect(result!.entry.has_psi).toBe(true);
  });

  it("returns null when oracle not on filesystem", () => {
    const root = mkdtempSync(join(tmpdir(), "ghq-"));
    mkdirSync(join(root, "Soul-Brews-Studio"), { recursive: true });
    expect(findInFilesystem("ghost", root)).toBeNull();
  });
});

// ─── findInTmux ──────────────────────────────────────────────────────────────

describe("findInTmux", () => {
  it("finds oracle from tmux window", async () => {
    const sessions = [{ name: "mawjs", windows: [{ name: "mawjs-oracle", index: 0 }] }];
    const result = await findInTmux("mawjs", async () => sessions as any);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("tmux");
    expect(result!.entry.name).toBe("mawjs");
  });

  it("returns null when oracle not in tmux", async () => {
    const sessions = [{ name: "other", windows: [{ name: "other-oracle", index: 0 }] }];
    const result = await findInTmux("mawjs", async () => sessions as any);
    expect(result).toBeNull();
  });
});

// ─── cmdOracleRegister — success ─────────────────────────────────────────────

describe("cmdOracleRegister — success", () => {
  it("adds discovered oracle to registry", async () => {
    let written: Record<string, unknown> | null = null;
    await cmdOracleRegister(
      "newbie",
      {},
      {
        readRawCache: () => ({ oracles: [] }),
        writeRawCache: (data) => { written = data; },
        findInFleetFn: () => null,
        findInTmuxFn: async () => null,
        findInFilesystemFn: (name) => ({
          source: "filesystem",
          entry: {
            org: "Soul-Brews-Studio",
            repo: `${name}-oracle`,
            name,
            local_path: `/tmp/${name}-oracle`,
            has_psi: true,
            has_fleet_config: false,
            budded_from: null,
            budded_at: null,
            federation_node: null,
            detected_at: new Date().toISOString(),
          },
        }),
      },
    );
    expect(written).not.toBeNull();
    const oracles = written!.oracles as OracleEntry[];
    expect(oracles).toHaveLength(1);
    expect(oracles[0].name).toBe("newbie");
  });

  it("prints JSON registration payload", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: unknown) => { logs.push(String(msg)); };
    try {
      await cmdOracleRegister(
        "jsonbie",
        { json: true },
        {
          readRawCache: () => ({ oracles: [] }),
          writeRawCache: () => {},
          findInFleetFn: () => null,
          findInTmuxFn: async () => ({
            source: "tmux",
            entry: entry({
              name: "jsonbie",
              repo: "jsonbie-oracle",
              local_path: "",
              has_psi: false,
              has_fleet_config: false,
              budded_from: null,
              budded_at: null,
              federation_node: null,
            }),
          }),
          findInFilesystemFn: () => { throw new Error("tmux result should win"); },
        },
      );
    } finally {
      console.log = originalLog;
    }

    const payload = JSON.parse(logs[0]);
    expect(payload.source).toBe("tmux");
    expect(payload.registered.name).toBe("jsonbie");
  });

  it("uses fleet source when available (priority)", async () => {
    let writtenEntry: OracleEntry | null = null;
    await cmdOracleRegister(
      "mawjs",
      {},
      {
        readRawCache: () => ({ oracles: [] }),
        writeRawCache: (data) => { writtenEntry = (data.oracles as OracleEntry[])[0]; },
        findInFleetFn: (name) => ({
          source: "fleet",
          entry: {
            org: "Soul-Brews-Studio",
            repo: `${name}-oracle`,
            name,
            local_path: "",
            has_psi: false,
            has_fleet_config: true,
            budded_from: "neo",
            budded_at: null,
            federation_node: null,
            detected_at: new Date().toISOString(),
          },
        }),
        findInTmuxFn: async () => { throw new Error("should not be called"); },
        findInFilesystemFn: () => { throw new Error("should not be called"); },
      },
    );
    expect(writtenEntry!.has_fleet_config).toBe(true);
    expect(writtenEntry!.budded_from).toBe("neo");
  });
});

// ─── cmdOracleRegister — collision error ─────────────────────────────────────

describe("cmdOracleRegister — collision", () => {
  it("throws when oracle already in registry", async () => {
    await expect(
      cmdOracleRegister(
        "existing",
        {},
        {
          readRawCache: () => ({ oracles: [entry({ name: "existing" })] }),
          writeRawCache: () => {},
          findInFleetFn: () => null,
          findInTmuxFn: async () => null,
          findInFilesystemFn: () => null,
        },
      ),
    ).rejects.toThrow("already registered");
  });
});

// ─── cmdOracleRegister — missing error ───────────────────────────────────────

describe("cmdOracleRegister — missing", () => {
  it("throws when oracle not found anywhere", async () => {
    await expect(
      cmdOracleRegister(
        "ghost",
        {},
        {
          readRawCache: () => ({ oracles: [] }),
          writeRawCache: () => {},
          findInFleetFn: () => null,
          findInTmuxFn: async () => null,
          findInFilesystemFn: () => null,
        },
      ),
    ).rejects.toThrow("not found");
  });
});
