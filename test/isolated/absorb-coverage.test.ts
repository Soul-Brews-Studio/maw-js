import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "maw-absorb-coverage-"));
const fleetDir = join(tmpRoot, "fleet");
const archiveSoulSyncPath = import.meta.resolve("../../src/vendor/mpr-plugins/archive/internal/soul-sync-impl.ts");

let ghqRoot = join(tmpRoot, "ghq");
let fleetEntries: any[] = [];
let ghqFindResults = new Map<string, string | null>();
let ghqFindCalls: string[] = [];
let hostExecCalls: string[] = [];
let hostExecErrorFor: string | null = null;
let hostExecError: Error | null = null;
let soulSyncCalls: unknown[][] = [];
let logs: string[] = [];
let errors: string[] = [];

const originalLog = console.log;
const originalError = console.error;
const originalTmux = process.env.TMUX;

mock.module("maw-js/sdk", () => ({
  FLEET_DIR: fleetDir,
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    if (hostExecErrorFor && cmd.includes(hostExecErrorFor)) {
      throw hostExecError ?? new Error("host exec failed");
    }
    return "";
  },
}));

mock.module("maw-js/config/ghq-root", () => ({
  getGhqRoot: () => ghqRoot,
}));

mock.module("maw-js/core/ghq", () => ({
  ghqFind: async (pattern: string) => {
    ghqFindCalls.push(pattern);
    return ghqFindResults.get(pattern) ?? null;
  },
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  fleetDirForWrite: () => fleetDir,
  loadFleetEntries: () => fleetEntries,
  loadFleet: () => fleetEntries.map(entry => entry.session),
}));

mock.module(archiveSoulSyncPath, () => ({
  cmdSoulSync: async (...args: unknown[]) => {
    soulSyncCalls.push(args);
  },
}));

const { default: absorbHandler } = await import("../../src/vendor/mpr-plugins/absorb/index.ts?absorb-coverage");
const { cmdAbsorb, findAbsorbFleetEntry } = await import("../../src/vendor/mpr-plugins/absorb/impl.ts?absorb-coverage");

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

function repoPath(slug: string) {
  return join(ghqRoot, "github.com", slug);
}

function prepareRepo(slug: string) {
  const path = repoPath(slug);
  mkdirSync(path, { recursive: true });
  return path;
}

function writeLearning(slug: string, name: string, body = "lesson") {
  const dir = join(repoPath(slug), "ψ", "memory", "learnings");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, "utf-8");
}

function fleetEntry(
  name: string,
  file: string,
  opts: { repo?: string; groupName?: string; syncPeers?: string[]; windows?: Array<Record<string, unknown>>; path?: string } = {},
) {
  const groupName = opts.groupName ?? file.replace(/^\d+-/, "").replace(/\.json$/, "");
  return {
    file,
    ...(opts.path ? { path: opts.path } : {}),
    num: parseInt(file, 10) || 0,
    groupName,
    session: {
      name,
      windows: opts.windows ?? [{ name: groupName, repo: opts.repo }],
      ...(opts.syncPeers === undefined ? {} : { sync_peers: opts.syncPeers }),
    },
  };
}

beforeEach(() => {
  ghqRoot = join(tmpRoot, "ghq");
  fleetEntries = [];
  ghqFindResults = new Map();
  ghqFindCalls = [];
  hostExecCalls = [];
  hostExecErrorFor = null;
  hostExecError = null;
  soulSyncCalls = [];
  delete process.env.TMUX;
  resetFleetDir();
  rmSync(ghqRoot, { recursive: true, force: true });
  resetConsoleCapture();
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("absorb handler", () => {
  test("prints help directly without patching console", async () => {
    const result = await absorbHandler({ source: "cli", args: ["--help"] } as any);

    expect(result).toEqual({ ok: true });
    expect(stripAnsi(output())).toContain("usage: maw absorb <donor> --into <receiver> [--dry-run]");
  });

  test("rejects missing --into before running absorb work", async () => {
    const result = await absorbHandler({ source: "cli", args: ["donor"] } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("usage: maw absorb <donor> --into <receiver> [--dry-run]");
    expect(hostExecCalls).toEqual([]);
  });

  test("captures command output through the writer on success", async () => {
    const writes: string[] = [];
    const donorFile = "011-donor.json";
    const receiverFile = "012-receiver.json";
    fleetEntries = [
      fleetEntry("011-donor", donorFile, { repo: "owner/donor-oracle" }),
      fleetEntry("012-receiver", receiverFile, { repo: "owner/receiver-oracle" }),
    ];
    writeFleetFile(donorFile);
    writeFleetFile(receiverFile);
    prepareRepo("owner/donor-oracle");
    prepareRepo("owner/receiver-oracle");

    const result = await absorbHandler({
      source: "cli",
      args: ["donor-oracle", "--into", "receiver-oracle", "--dry-run"],
      writer: (...args: any[]) => writes.push(args.map(String).join(" ")),
    } as any);

    expect(result).toEqual({ ok: true, output: undefined });
    expect(stripAnsi(writes.join("\n"))).toContain("Absorbing donor -> receiver");
    expect(stripAnsi(writes.join("\n"))).toContain("[dry-run] would switch client: tmux switch-client -t '012-receiver'");
  });
});

describe("absorb impl", () => {
  test("matches donor and receiver names across session, group, repo, and -oracle suffixes", () => {
    const entries = [
      fleetEntry("050-sage-vector-fix", "050-sage-vector-fix.json", { repo: "Soul-Brews-Studio/sage-vector-fix-oracle" }),
    ];

    expect(findAbsorbFleetEntry(entries as any, "050-sage-vector-fix")?.session.name).toBe("050-sage-vector-fix");
    expect(findAbsorbFleetEntry(entries as any, "sage-vector-fix")?.session.name).toBe("050-sage-vector-fix");
    expect(findAbsorbFleetEntry(entries as any, "sage-vector-fix-oracle")?.session.name).toBe("050-sage-vector-fix");
  });

  test("dry-run previews sync, archive, and the final switch without side effects", async () => {
    const donorFile = "021-donor.json";
    const receiverFile = "022-receiver.json";
    fleetEntries = [
      fleetEntry("021-donor", donorFile, { repo: "owner/donor-oracle", syncPeers: ["peer"] }),
      fleetEntry("022-receiver", receiverFile, { repo: "owner/receiver-oracle" }),
    ];
    writeFleetFile(donorFile);
    writeFleetFile(receiverFile);
    prepareRepo("owner/donor-oracle");
    prepareRepo("owner/receiver-oracle");

    await cmdAbsorb("donor", "receiver", { dryRun: true });

    const out = stripAnsi(output());
    expect(hostExecCalls).toEqual([]);
    expect(soulSyncCalls).toEqual([]);
    expect(existsSync(join(fleetDir, donorFile))).toBe(true);
    expect(existsSync(join(fleetDir, `${donorFile}.disabled`))).toBe(false);
    expect(out).toContain("Absorbing donor -> receiver");
    expect(out).toContain("[dry-run] would sync psi memory:");
    expect(out).toContain("[dry-run] would archive donor via: maw archive donor");
    expect(out).toContain("[dry-run] would switch client: tmux switch-client -t '022-receiver'");
    expect(out).toContain("absorb preview complete; no files, fleet entries, repos, or tmux clients changed");
  });

  test("syncs donor psi memory, archives donor, then switches to the receiver session", async () => {
    process.env.TMUX = "/tmp/tmux-100/default,1,0";
    const donorFile = "031-donor.json";
    const receiverFile = "032-receiver.json";
    fleetEntries = [
      fleetEntry("031-donor", donorFile, { repo: "owner/donor-oracle", syncPeers: ["peer"] }),
      fleetEntry("032-receiver", receiverFile, { repo: "owner/receiver-oracle" }),
    ];
    writeFleetFile(donorFile);
    writeFleetFile(receiverFile);
    prepareRepo("owner/donor-oracle");
    prepareRepo("owner/receiver-oracle");
    writeLearning("owner/donor-oracle", "lesson.md", "absorbed");

    await cmdAbsorb("donor-oracle", "receiver-oracle");

    const out = stripAnsi(output());
    expect(existsSync(join(repoPath("owner/receiver-oracle"), "ψ", "memory", "learnings", "lesson.md"))).toBe(true);
    expect(soulSyncCalls).toEqual([[undefined, { cwd: repoPath("owner/donor-oracle") }]]);
    expect(hostExecCalls).toEqual([
      "gh repo archive owner/donor-oracle --yes",
      "tmux switch-client -t '032-receiver'",
    ]);
    expect(existsSync(join(fleetDir, `${donorFile}.disabled`))).toBe(true);
    expect(out).toContain("psi memory sync complete: 1 learnings");
    expect(out).toContain("switched client to 032-receiver");
    expect(out).toContain("donor absorbed into receiver; donor archived");
  });

  test("reports a no-op psi sync and manual switch command outside tmux", async () => {
    const donorFile = "041-donor.json";
    const receiverFile = "042-receiver.json";
    fleetEntries = [
      fleetEntry("041-donor", donorFile, { repo: "owner/donor-oracle" }),
      fleetEntry("042-receiver", receiverFile, { repo: "owner/receiver-oracle" }),
    ];
    writeFleetFile(donorFile);
    writeFleetFile(receiverFile);
    prepareRepo("owner/donor-oracle");
    prepareRepo("owner/receiver-oracle");

    await cmdAbsorb("donor", "receiver");

    const out = stripAnsi(output());
    expect(hostExecCalls).toEqual(["gh repo archive owner/donor-oracle --yes"]);
    expect(out).toContain("psi memory sync complete: nothing new");
    expect(out).toContain("not inside tmux; run manually: tmux switch-client -t '042-receiver'");
  });

  test("reports donor archived when the fleet file came from a source path", async () => {
    const stateFleetDir = join(tmpRoot, "state-fleet-absorb");
    rmSync(stateFleetDir, { recursive: true, force: true });
    mkdirSync(stateFleetDir, { recursive: true });
    const donorFile = "043-donor.json";
    const receiverFile = "044-receiver.json";
    const donorPath = join(stateFleetDir, donorFile);
    fleetEntries = [
      fleetEntry("043-donor", donorFile, { repo: "owner/donor-oracle", path: donorPath }),
      fleetEntry("044-receiver", receiverFile, { repo: "owner/receiver-oracle" }),
    ];
    writeFileSync(donorPath, JSON.stringify({ session: "state" }), "utf-8");
    writeFleetFile(receiverFile);
    prepareRepo("owner/donor-oracle");
    prepareRepo("owner/receiver-oracle");

    await cmdAbsorb("donor", "receiver");

    const out = stripAnsi(output());
    expect(existsSync(donorPath)).toBe(false);
    expect(existsSync(`${donorPath}.disabled`)).toBe(true);
    expect(existsSync(join(fleetDir, `${donorFile}.disabled`))).toBe(false);
    expect(out).toContain("donor absorbed into receiver; donor archived");
  });

  test("keeps absorb successful when only the final tmux switch fails", async () => {
    process.env.TMUX = "/tmp/tmux-100/default,1,0";
    hostExecErrorFor = "tmux switch-client";
    hostExecError = new Error("no current client");
    const donorFile = "051-donor.json";
    const receiverFile = "052-receiver.json";
    fleetEntries = [
      fleetEntry("051-donor", donorFile, { repo: "owner/donor-oracle" }),
      fleetEntry("052-receiver", receiverFile, { repo: "owner/receiver-oracle" }),
    ];
    writeFleetFile(donorFile);
    writeFleetFile(receiverFile);
    prepareRepo("owner/donor-oracle");
    prepareRepo("owner/receiver-oracle");

    await cmdAbsorb("donor", "receiver");

    const out = stripAnsi(output());
    expect(hostExecCalls).toEqual([
      "gh repo archive owner/donor-oracle --yes",
      "tmux switch-client -t '052-receiver'",
    ]);
    expect(out).toContain("could not switch to receiver: no current client");
    expect(out).toContain("run manually: tmux switch-client -t '052-receiver'");
    expect(out).toContain("donor absorbed into receiver; donor archived");
  });

  test("accepts ghq-resolved paths before falling back to fleet repo paths", async () => {
    const donorFile = "061-donor.json";
    const receiverFile = "062-receiver.json";
    const donorResolved = join(tmpRoot, "custom", "donor-oracle");
    const receiverResolved = join(tmpRoot, "custom", "receiver-oracle");
    fleetEntries = [
      fleetEntry("061-donor", donorFile, { repo: "owner/donor-oracle" }),
      fleetEntry("062-receiver", receiverFile, { repo: "owner/receiver-oracle" }),
    ];
    writeFleetFile(donorFile);
    writeFleetFile(receiverFile);
    mkdirSync(donorResolved, { recursive: true });
    mkdirSync(receiverResolved, { recursive: true });
    ghqFindResults.set("/donor-oracle$", donorResolved);
    ghqFindResults.set("/receiver-oracle$", receiverResolved);

    await cmdAbsorb("donor", "receiver", { dryRun: true });

    const out = stripAnsi(output());
    expect(ghqFindCalls).toEqual(["/donor-oracle$", "/receiver-oracle$"]);
    expect(out).toContain(`would sync psi memory: ${donorResolved} -> ${receiverResolved}`);
  });

  test("rejects missing donors, missing receivers, self-absorbs, and unresolved paths", async () => {
    const donorFile = "071-donor.json";
    fleetEntries = [fleetEntry("071-donor", donorFile, { repo: "owner/donor-oracle" })];
    writeFleetFile(donorFile);

    await expect(cmdAbsorb("ghost", "donor")).rejects.toThrow("donor oracle 'ghost' not found");
    await expect(cmdAbsorb("donor", "ghost")).rejects.toThrow("receiver oracle 'ghost' not found");
    await expect(cmdAbsorb("donor", "donor")).rejects.toThrow("donor and receiver must be different");

    fleetEntries = [
      fleetEntry("081-donor", "081-donor.json", { repo: "owner/missing-donor-oracle" }),
      fleetEntry("082-receiver", "082-receiver.json", { repo: "owner/receiver-oracle" }),
    ];
    writeFleetFile("081-donor.json");
    writeFleetFile("082-receiver.json");
    prepareRepo("owner/receiver-oracle");
    await expect(cmdAbsorb("donor", "receiver")).rejects.toThrow("could not resolve donor oracle path");

    prepareRepo("owner/missing-donor-oracle");
    rmSync(repoPath("owner/receiver-oracle"), { recursive: true, force: true });
    await expect(cmdAbsorb("donor", "receiver")).rejects.toThrow("could not resolve receiver oracle path");
  });
});
