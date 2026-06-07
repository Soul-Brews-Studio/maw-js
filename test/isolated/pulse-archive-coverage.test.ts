import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type WorktreeInfo = {
  name: string;
  path: string;
  mainRepo: string;
  branch: string;
  status: "active" | "stale" | "orphan";
};

const tmpRoot = mkdtempSync(join(tmpdir(), "maw-pulse-archive-coverage-"));
const fleetDir = join(tmpRoot, "fleet");

const archiveSoulSyncPath = import.meta.resolve("../../src/vendor/mpr-plugins/archive/internal/soul-sync-impl.ts");

let pulseAddCalls: Array<{ title: string; opts: { oracle?: string; priority?: string; wt?: string } }> = [];
let pulseLsCalls: Array<{ sync?: boolean }> = [];
let pulseAddError: Error | null = null;
let pulseLsError: Error | null = null;
let pulseLsStderr: string | null = null;

let worktrees: WorktreeInfo[] = [];
let scanWorktreeCalls = 0;
let cleanupCalls: string[] = [];
let cleanupLogs = new Map<string, string[]>();

let ghqRoot = join(tmpRoot, "ghq");
let fleetEntries: any[] = [];
let hostExecCalls: string[] = [];
let hostExecError: Error | null = null;
let soulSyncCalls: unknown[][] = [];
let soulSyncError: Error | null = null;

let logs: string[] = [];
let errors: string[] = [];

const originalLog = console.log;
const originalError = console.error;

mock.module("maw-js/commands/shared/pulse", () => ({
  cmdPulseAdd: async (title: string, opts: { oracle?: string; priority?: string; wt?: string }) => {
    pulseAddCalls.push({ title, opts });
    console.log(`mock add: ${title}`);
    if (pulseAddError) throw pulseAddError;
  },
  cmdPulseLs: async (opts: { sync?: boolean }) => {
    pulseLsCalls.push(opts);
    console.log(`mock ls sync=${Boolean(opts.sync)}`);
    if (pulseLsStderr) console.error(pulseLsStderr);
    if (pulseLsError) throw pulseLsError;
  },
}));

mock.module("maw-js/worktrees", () => ({
  scanWorktrees: async () => {
    scanWorktreeCalls += 1;
    return worktrees;
  },
  cleanupWorktree: async (path: string) => {
    cleanupCalls.push(path);
    return cleanupLogs.get(path) ?? [`cleaned ${path}`];
  },
}));

mock.module("maw-js/sdk", () => ({
  FLEET_DIR: fleetDir,
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    if (hostExecError) throw hostExecError;
    return "";
  },
}));

mock.module("maw-js/config/ghq-root", () => ({
  getGhqRoot: () => ghqRoot,
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  fleetDirForWrite: () => fleetDir,
  loadFleetEntries: () => fleetEntries,
}));

mock.module(archiveSoulSyncPath, () => ({
  cmdSoulSync: async (...args: unknown[]) => {
    soulSyncCalls.push(args);
    if (soulSyncError) throw soulSyncError;
  },
}));

const { default: pulseHandler } = await import("../../src/vendor/mpr-plugins/pulse/index.ts?pulse-archive-coverage");
const { cmdArchive } = await import("../../src/vendor/mpr-plugins/archive/impl.ts?pulse-archive-coverage");

function resetConsoleCapture() {
  logs = [];
  errors = [];
  console.log = (...args: any[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: any[]) => errors.push(args.map(String).join(" "));
}

function output() {
  return [...logs, ...errors].join("\n");
}

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function resetFleetDir() {
  rmSync(fleetDir, { recursive: true, force: true });
  mkdirSync(fleetDir, { recursive: true });
}

function writeFleetFile(file: string) {
  writeFileSync(join(fleetDir, file), JSON.stringify({ session: "stub" }), "utf-8");
}

function fleetEntry(
  name: string,
  file: string,
  opts: { repo?: string; syncPeers?: string[]; windows?: Array<Record<string, unknown>>; path?: string } = {},
) {
  return {
    file,
    ...(opts.path ? { path: opts.path } : {}),
    session: {
      name,
      windows: opts.windows ?? [{ repo: opts.repo }],
      ...(opts.syncPeers === undefined ? {} : { sync_peers: opts.syncPeers }),
    },
  };
}

beforeEach(() => {
  pulseAddCalls = [];
  pulseLsCalls = [];
  pulseAddError = null;
  pulseLsError = null;
  pulseLsStderr = null;

  worktrees = [];
  scanWorktreeCalls = 0;
  cleanupCalls = [];
  cleanupLogs = new Map();

  ghqRoot = join(tmpRoot, "ghq");
  fleetEntries = [];
  hostExecCalls = [];
  hostExecError = null;
  soulSyncCalls = [];
  soulSyncError = null;

  resetFleetDir();
  resetConsoleCapture();
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("vendor pulse handler coverage", () => {
  test("add forwards title and flags, including --worktree alias, through the writer", async () => {
    const writes: string[] = [];

    const result = await pulseHandler({
      source: "cli",
      args: ["add", "ship task", "--oracle", "neo", "--priority", "high", "--worktree", "wt-7"],
      writer: (...args: any[]) => writes.push(args.map(String).join(" ")),
    } as any);

    expect(result).toEqual({ ok: true, output: undefined });
    expect(pulseAddCalls).toEqual([{ title: "ship task", opts: { oracle: "neo", priority: "high", wt: "wt-7" } }]);
    expect(writes).toEqual(["mock add: ship task"]);
  });

  test("add rejects missing titles before loading the shared command", async () => {
    const result = await pulseHandler({ source: "cli", args: ["add", "--oracle", "neo"] } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('usage: maw pulse add "task title"');
    expect(pulseAddCalls).toEqual([]);
  });

  test("ls and list dispatch with the expected sync option", async () => {
    const plain = await pulseHandler({ source: "cli", args: ["ls"] } as any);
    const synced = await pulseHandler({ source: "cli", args: ["list", "--sync"] } as any);

    expect(plain.ok).toBe(true);
    expect(stripAnsi(plain.output)).toContain("mock ls sync=false");
    expect(synced.ok).toBe(true);
    expect(stripAnsi(synced.output)).toContain("mock ls sync=true");
    expect(pulseLsCalls).toEqual([{ sync: false }, { sync: true }]);
  });

  test("api-sourced invocations ignore args and return usage", async () => {
    const result = await pulseHandler({ source: "api", args: ["ls"] } as any);

    expect(result).toEqual({ ok: false, error: "usage: maw pulse <add|ls|cleanup> [opts]" });
    expect(pulseLsCalls).toEqual([]);
  });

  test("cleanup reports when every worktree is active", async () => {
    worktrees = [
      { name: "main", path: "/repo/main", mainRepo: "repo", branch: "alpha", status: "active" },
    ];

    const result = await pulseHandler({ source: "cli", args: ["cleanup"] } as any);

    expect(result.ok).toBe(true);
    expect(scanWorktreeCalls).toBe(1);
    expect(cleanupCalls).toEqual([]);
    expect(stripAnsi(result.output)).toContain("All worktrees are active. Nothing to clean.");
  });

  test("cleanup dry-run prints stale and orphan worktrees without removing them", async () => {
    worktrees = [
      { name: "main", path: "/repo/main", mainRepo: "repo", branch: "alpha", status: "active" },
      { name: "old", path: "/repo/old", mainRepo: "repo", branch: "stale-branch", status: "stale" },
      { name: "lost", path: "/repo/lost", mainRepo: "repo", branch: "lost-branch", status: "orphan" },
    ];

    const result = await pulseHandler({ source: "cli", args: ["clean", "--dry-run"] } as any);
    const out = stripAnsi(result.output);

    expect(result.ok).toBe(true);
    expect(cleanupCalls).toEqual([]);
    expect(out).toContain("Worktree Cleanup");
    expect(out).toContain("1 active | 1 stale | 1 orphan");
    expect(out).toContain("stale  old (repo) [stale-branch]");
    expect(out).toContain("orphan  lost (repo) [lost-branch]");
    expect(out).toContain("(dry run — use without --dry-run to clean)");
  });

  test("cleanup removes stale worktrees and prints cleanup logs", async () => {
    worktrees = [
      { name: "old", path: "/repo/old", mainRepo: "repo", branch: "stale-branch", status: "stale" },
    ];
    cleanupLogs.set("/repo/old", ["removed git worktree", "pruned metadata"]);

    const result = await pulseHandler({ source: "cli", args: ["cleanup"] } as any);
    const out = stripAnsi(result.output);

    expect(result.ok).toBe(true);
    expect(cleanupCalls).toEqual(["/repo/old"]);
    expect(out).toContain("stale  old (repo) [stale-branch]");
    expect(out).toContain("✓ removed git worktree");
    expect(out).toContain("✓ pruned metadata");
  });

  test("unknown subcommands return usage and command errors preserve captured logs", async () => {
    const unknown = await pulseHandler({ source: "cli", args: ["wat"] } as any);
    expect(unknown).toEqual({ ok: false, error: "usage: maw pulse <add|ls|cleanup> [opts]" });

    pulseLsError = new Error("ls exploded");
    pulseLsStderr = "stderr before fail";
    const failed = await pulseHandler({ source: "cli", args: ["ls"] } as any);

    expect(failed.ok).toBe(false);
    expect(stripAnsi(failed.error)).toContain("mock ls sync=false");
    expect(stripAnsi(failed.error)).toContain("stderr before fail");
    expect(stripAnsi(failed.output)).toContain("mock ls sync=false");
  });
});

describe("archive impl coverage", () => {
  test("throws when the requested oracle is missing from fleet config", async () => {
    await expect(cmdArchive("ghost")).rejects.toThrow("oracle 'ghost' not found in fleet config");
  });

  test("dry-run previews sync, fleet disable, repo archive, and death logging without side effects", async () => {
    const file = "neo.json";
    fleetEntries = [fleetEntry("001-neo", file, { repo: "owner/repo", syncPeers: ["pulse", "hermes"] })];
    writeFleetFile(file);

    await cmdArchive("neo", { dryRun: true });

    const out = stripAnsi(output());
    expect(soulSyncCalls).toEqual([]);
    expect(hostExecCalls).toEqual([]);
    expect(existsSync(join(fleetDir, file))).toBe(true);
    expect(existsSync(join(fleetDir, `${file}.disabled`))).toBe(false);
    expect(out).toContain("Archiving — neo");
    expect(out).toContain("[dry-run] would soul-sync to pulse, hermes");
    expect(out).toContain(`[dry-run] would disable: ${file} → ${file}.disabled`);
    expect(out).toContain("[dry-run] would archive: gh repo archive owner/repo");
    expect(out).toContain("[dry-run] would log death to family registry");
  });

  test("non-dry archive soul-syncs from repo cwd, disables fleet config, archives GitHub, and prints recovery hints", async () => {
    const file = "neo.json";
    fleetEntries = [fleetEntry("001-neo", file, { repo: "owner/repo", syncPeers: ["pulse"] })];
    writeFleetFile(file);

    await cmdArchive("neo");

    const out = stripAnsi(output());
    expect(soulSyncCalls).toEqual([[undefined, { cwd: join(ghqRoot, "github.com", "owner/repo") }]]);
    expect(hostExecCalls).toEqual(["gh repo archive owner/repo --yes"]);
    expect(existsSync(join(fleetDir, file))).toBe(false);
    expect(existsSync(join(fleetDir, `${file}.disabled`))).toBe(true);
    expect(out).toContain("final soul-sync to peers");
    expect(out).toContain("soul-sync complete");
    expect(out).toContain(`fleet config disabled: ${file}.disabled`);
    expect(out).toContain("GitHub repo archived: owner/repo");
    expect(out).toContain("neo archived — ψ/ preserved locally, knowledge synced to peers");
    expect(out).toContain("Nothing is deleted (Principle 1)");
    expect(out).toContain(`To unarchive: rename ${file}.disabled → ${file} + gh repo unarchive`);
  });

  test("non-dry archive handles local-only oracles without repo archive work", async () => {
    const file = "solo.json";
    fleetEntries = [fleetEntry("002-solo", file, { windows: [] })];
    writeFleetFile(file);

    await cmdArchive("solo");

    const out = stripAnsi(output());
    expect(soulSyncCalls).toEqual([]);
    expect(hostExecCalls).toEqual([]);
    expect(existsSync(join(fleetDir, `${file}.disabled`))).toBe(true);
    expect(out).toContain("no sync_peers configured — knowledge stays local");
    expect(out).toContain("solo archived — ψ/ preserved locally, knowledge synced to peers");
  });

  test("non-dry archive disables the loaded source-path fleet config", async () => {
    const stateFleetDir = join(tmpRoot, "state-fleet-archive");
    rmSync(stateFleetDir, { recursive: true, force: true });
    mkdirSync(stateFleetDir, { recursive: true });
    const file = "070-stateful.json";
    const sourcePath = join(stateFleetDir, file);
    fleetEntries = [fleetEntry("070-stateful", file, { repo: "owner/stateful", path: sourcePath })];
    writeFileSync(sourcePath, JSON.stringify({ session: "state" }), "utf-8");

    await cmdArchive("stateful");

    expect(existsSync(sourcePath)).toBe(false);
    expect(existsSync(`${sourcePath}.disabled`)).toBe(true);
    expect(existsSync(join(fleetDir, `${file}.disabled`))).toBe(false);
    expect(hostExecCalls).toEqual(["gh repo archive owner/stateful --yes"]);
  });

  test("non-dry archive reports soul-sync, fleet rename, and GitHub archive failures without throwing", async () => {
    const file = "broken.json";
    fleetEntries = [fleetEntry("003-broken", file, { repo: "owner/broken", syncPeers: ["offline"] })];
    soulSyncError = new Error("peer offline");
    hostExecError = new Error("repo already archived");

    await cmdArchive("broken");

    const out = stripAnsi(output());
    expect(soulSyncCalls).toEqual([[undefined, { cwd: join(ghqRoot, "github.com", "owner/broken") }]]);
    expect(hostExecCalls).toEqual(["gh repo archive owner/broken --yes"]);
    expect(out).toContain("soul-sync failed (peers may be offline)");
    expect(out).toContain("could not disable fleet config:");
    expect(out).toContain("archive failed: repo already archived");
    expect(out).toContain("broken archived — ψ/ preserved locally, knowledge synced to peers");
  });
});
