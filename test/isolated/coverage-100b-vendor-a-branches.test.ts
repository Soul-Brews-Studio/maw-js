import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventEmitter } from "events";

const realFs = await import("fs");
const root = process.cwd();
const bgRoot = join(root, "src/vendor/mpr-plugins/bg/src");
const budRoot = join(root, "src/vendor/mpr-plugins/bud");
const initRoot = join(root, "src/vendor/mpr-plugins/init");

let tmpRoot = "";
let logs: string[] = [];
let errors: string[] = [];
let hostExecCalls: string[] = [];
let hostExecImpl: (cmd: string) => Promise<string> = async (cmd) => {
  hostExecCalls.push(cmd);
  return "";
};
let ghqRoot = "";
let fleetEntries: Array<{ file: string; session: { name: string } }> = [];
let wakeCalls: unknown[] = [];
let soulSyncCalls: unknown[] = [];
let shouldWake = true;
let splitThrows = false;
let parseResult: { ok: true; opts: any } | { ok: false; error: string } = { ok: false, error: "parse failed" };
let pluginManifest: any = null;
let extractOk = true;
let hashFileCalls: string[] = [];
let configExistsValue = false;
let backupPath = "";
let bootstrapThrows = false;
let spawnSyncCalls: string[][] = [];
let spawnCalls: string[][] = [];
let spawnSyncImpl: (cmd: string, args: string[]) => { status?: number | null; stdout?: string; stderr?: string; error?: Error } = (_cmd, args) => {
  spawnSyncCalls.push(args);
  if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "" };
  return { status: 0, stdout: "", stderr: "" };
};

const original = {
  log: console.log,
  error: console.error,
  stderrWrite: process.stderr.write,
  env: { ...process.env },
  cwd: process.cwd(),
  dateNow: Date.now,
  kill: process.kill,
};

mock.module("node:child_process", () => ({
  spawnSync: (cmd: string, args: string[]) => spawnSyncImpl(cmd, args),
  spawn: (cmd: string, args: string[]) => {
    spawnCalls.push([cmd, ...args]);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  },
}));
mock.module("child_process", () => ({
  spawnSync: (cmd: string, args: string[]) => spawnSyncImpl(cmd, args),
  spawn: (cmd: string, args: string[]) => {
    spawnCalls.push([cmd, ...args]);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  },
}));

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string) => hostExecImpl(cmd),
  FLEET_DIR: join(tmpRoot || tmpdir(), "fleet"),
}));
mock.module("maw-js/config/ghq-root", () => ({ getGhqRoot: () => ghqRoot }));
mock.module("maw-js/commands/shared/wake", () => ({
  cmdWake: async (...args: unknown[]) => { wakeCalls.push(args); },
  fetchIssuePrompt: async (issue: number, slug: string) => `issue ${issue} for ${slug}`,
}));
mock.module("maw-js/commands/shared/should-auto-wake", () => ({
  shouldAutoWake: (name: string, ctx: unknown) => ({ wake: shouldWake, reason: `skip ${name} ${JSON.stringify(ctx)}` }),
}));
mock.module("maw-js/commands/shared/wake-target", () => ({
  parseWakeTarget: (value: string) => value.includes("/") ? { oracle: value.split("/").pop()?.replace(/-oracle$/, "") ?? value, slug: value } : null,
  ensureCloned: async (slug: string) => { hostExecCalls.push(`ensureCloned:${slug}`); },
}));
mock.module("maw-js/commands/shared/fleet-load", () => ({
  fleetDirForWrite: () => join(tmpRoot || tmpdir(), "fleet"),
  loadFleetEntries: () => fleetEntries,
  loadFleet: () => [],
}));
mock.module(join(budRoot, "internal/soul-sync-impl"), () => ({
  cmdSoulSync: async (...args: unknown[]) => { soulSyncCalls.push(args); throw new Error("empty psi"); },
  syncDir: (src: string, dst: string) => { hostExecCalls.push(`syncDir:${src}->${dst}`); },
}));
mock.module(join(root, "src/vendor/mpr-plugins/split/impl"), () => ({
  cmdSplit: async (name: string) => { if (splitThrows) throw new Error(`split nope ${name}`); },
}));
mock.module("maw-js/config", () => ({ loadConfig: () => ({ githubOrg: "ConfigOrg" }) }));
mock.module("maw-js/core/matcher/normalize-target", () => ({ normalizeTarget: (s: string) => s.replace(/\/$/, "").replace(/\.git$/, "") }));
mock.module("maw-js/core/fleet/validate", () => ({ assertValidOracleName: (name: string) => { if (name === "bad-view") throw new Error("reserved"); } }));
mock.module("maw-js/core/fleet/leaf", () => ({ writeSignal: (...args: unknown[]) => { hostExecCalls.push(`writeSignal:${JSON.stringify(args)}`); } }));
mock.module("maw-js/core/fleet/nicknames", () => ({
  validateNickname: (value: string) => value.trim() ? { ok: true, value: value.trim() } : { ok: false, error: "bad nickname" },
  writeNickname: (...args: unknown[]) => { hostExecCalls.push(`writeNickname:${JSON.stringify(args)}`); },
  setCachedNickname: (...args: unknown[]) => { hostExecCalls.push(`setCachedNickname:${JSON.stringify(args)}`); },
}));
mock.module(join(budRoot, "smart-default-org"), () => ({
  resolveOrg: async ({ flag, env, config }: any) => ({ org: flag ?? env ?? config ?? "FallbackOrg", source: flag ? "flag" : "config" }),
  formatOrgSource: (res: any) => `${res.source}:${res.org}`,
}));
mock.module(join(budRoot, "bud-repo"), () => ({ ensureBudRepo: async (_slug: string, predicted: string) => predicted }));
mock.module(join(budRoot, "bud-init"), () => ({
  initVault: (repoPath: string) => { const psi = join(repoPath, "ψ"); mkdirSync(psi, { recursive: true }); return psi; },
  generateClaudeMd: (...args: unknown[]) => { hostExecCalls.push(`generateClaudeMd:${JSON.stringify(args)}`); },
  configureFleet: (name: string) => join(tmpRoot, `${name}.json`),
  writeBirthNote: (...args: unknown[]) => { hostExecCalls.push(`writeBirthNote:${JSON.stringify(args)}`); },
}));
mock.module(join(budRoot, "bud-wake"), () => ({ finalizeBud: async (...args: unknown[]) => { hostExecCalls.push(`finalizeBud:${JSON.stringify(args)}`); } }));
mock.module(join(budRoot, "from-repo-git"), () => ({
  cloneShallow: async (target: string) => { const dir = mkdtempSync(join(tmpdir(), "from-repo-clone-")); mkdirSync(join(dir, ".git")); hostExecCalls.push(`clone:${target}`); return dir; },
  cleanupClone: (dir: string) => { hostExecCalls.push(`cleanup:${dir}`); rmSync(dir, { recursive: true, force: true }); },
  branchCommitPushPR: async (target: string, stem: string, log: (m: string) => void) => { log(`branch ${stem}`); return `https://example.test/${target}`; },
}));
mock.module(join(budRoot, "from-repo-fleet"), () => ({
  registerFleetEntry: ({ stem }: any) => ({ created: stem !== "old", file: join(tmpRoot, `${stem}.json`) }),
}));
mock.module(join(budRoot, "from-repo-seed"), () => ({
  seedFromParent: (_target: string, parent: string) => { if (parent === "explode") throw new Error("seed boom"); },
  copyPeersSnapshot: () => { throw new Error("peers boom"); },
}));
mock.module(join(initRoot, "non-interactive"), () => ({ parseNonInteractive: () => parseResult }));
mock.module(join(initRoot, "write-config"), () => ({
  buildConfig: (cfg: Record<string, unknown>) => ({ built: true, ...cfg }),
  configExists: () => configExistsValue,
  backupConfig: () => backupPath,
  writeConfigAtomic: (...args: unknown[]) => { hostExecCalls.push(`writeConfig:${JSON.stringify(args)}`); },
}));
mock.module(join(initRoot, "federation"), () => ({ generateFederationToken: () => "generated-token" }));
mock.module(join(initRoot, "bootstrap-plugins-lock"), () => ({
  bootstrapPluginsLock: () => { if (bootstrapThrows) throw new Error("boot failed"); return { created: true, path: join(tmpRoot, "plugins.lock") }; },
}));
mock.module(join(initRoot, "prompts"), () => ({
  ttyAsk: async () => "",
  runPromptLoop: async () => ({ node: "node", token: "tok", federate: false, peers: [] }),
}));
mock.module("maw-js/plugin/registry", () => ({
  hashFile: (path: string) => { hashFileCalls.push(path); return "sha256:" + "a".repeat(64); },
}));
mock.module(join(initRoot, "internal/install-manifest-helpers"), () => ({
  readManifest: () => pluginManifest,
}));
mock.module(join(initRoot, "internal/install-extraction"), () => ({
  extractTarball: (_tarball: string, staging: string) => {
    if (!extractOk) return { ok: false, error: "extract failed" };
    if (pluginManifest?.entry) {
      mkdirSync(join(staging, pluginManifest.entry.split("/").slice(0, -1).join("/")), { recursive: true });
      writeFileSync(join(staging, pluginManifest.entry), "entry");
    }
    if (pluginManifest?.artifact?.path) {
      mkdirSync(join(staging, pluginManifest.artifact.path.split("/").slice(0, -1).join("/")), { recursive: true });
      writeFileSync(join(staging, pluginManifest.artifact.path), "artifact");
    }
    return { ok: true };
  },
}));
mock.module("maw-js/core/paths", () => ({ CONFIG_FILE: join(tmpRoot || tmpdir(), "maw.config.json"), FLEET_DIR: join(tmpRoot || tmpdir(), "fleet") }));

const { parseFlags } = await import("../../src/vendor/mpr-plugins/bg/src/internal/parse-flags.ts?coverage-100b-a");
const bgImpl = await import("../../src/vendor/mpr-plugins/bg/src/impl.ts?coverage-100b-a");
const initImpl = await import("../../src/vendor/mpr-plugins/init/impl.ts?coverage-100b-a");
const pluginLock = await import("../../src/vendor/mpr-plugins/init/internal/plugin-lock.ts?coverage-100b-a");
const budWake = await import("../../src/vendor/mpr-plugins/bud/bud-wake.ts?coverage-100b-a");
const budImpl = await import("../../src/vendor/mpr-plugins/bud/impl.ts?coverage-100b-a");
const peersStore = await import("../../src/vendor/mpr-plugins/bud/internal/peers-store.ts?coverage-100b-a");
const budRepoReal = await import("../../src/vendor/mpr-plugins/bud/bud-repo.ts?coverage-100b-real");
const fromRepo = await import("../../src/vendor/mpr-plugins/bud/from-repo.ts?coverage-100b-a");
const fromRepoExec = await import("../../src/vendor/mpr-plugins/bud/from-repo-exec.ts?coverage-100b-a");
const dreamImpl = await import("../../src/vendor/mpr-plugins/dream/impl.ts?coverage-100b-a");

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "coverage-100b-vendor-a-"));
  ghqRoot = tmpRoot;
  logs = [];
  errors = [];
  hostExecCalls = [];
  fleetEntries = [];
  wakeCalls = [];
  soulSyncCalls = [];
  shouldWake = true;
  splitThrows = false;
  spawnSyncCalls = [];
  spawnCalls = [];
  parseResult = { ok: false, error: "parse failed" };
  configExistsValue = false;
  backupPath = join(tmpRoot, "config.bak");
  bootstrapThrows = false;
  pluginManifest = null;
  extractOk = true;
  hashFileCalls = [];
  hostExecImpl = async (cmd: string) => { hostExecCalls.push(cmd); return ""; };
  spawnSyncImpl = (_cmd, args) => {
    spawnSyncCalls.push(args);
    if (args[0] === "has-session") return { status: 1, stdout: "", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  process.stderr.write = ((chunk: string | Uint8Array) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.chdir(tmpRoot);
  process.env.MAW_TEST_MODE = "1";
  delete process.env.TMUX;
  delete process.env.PEERS_FILE;
  delete process.env.MAW_PLUGINS_LOCK;
});

afterEach(() => {
  console.log = original.log;
  console.error = original.error;
  process.stderr.write = original.stderrWrite;
  process.chdir(original.cwd);
  Date.now = original.dateNow;
  process.kill = original.kill;
  process.env = { ...original.env };
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("bg vendor branch coverage", () => {
  test("parseFlags preserves -- remainder, rejects missing values, and keeps unknown flags positional", () => {
    expect(parseFlags(["--name", "job", "--", "--not-a-flag", "pos"])).toEqual({ name: "job", _: ["--not-a-flag", "pos"] });
    expect(() => parseFlags(["--older-than"])).toThrow("requires a value");
    expect(parseFlags(["--mystery", "plain"])._).toEqual(["--mystery", "plain"]);
  });

  test("bg impl exported functions run against mocked tmux", async () => {
    expect(bgImpl.deriveSlug("!!!")).toMatch(/^cmd-[a-f0-9]{4}$/);
    expect(bgImpl.holdsOpen("echo hi")).toContain("[done — exit %d]");
    expect(bgImpl.parseDuration("2h")).toBe(7200);
    expect(() => bgImpl.parseDuration("nope")).toThrow("invalid --older-than");
    expect(bgImpl.bgSpawn(" echo hi ", { name: "job-1" })).toEqual({ slug: "job-1", session: "maw-bg-job-1", cmd: "echo hi" });
    expect(spawnSyncCalls.some((args) => args.includes("new-session"))).toBe(true);
    process.env.TMUX = "/tmp/tmux";
    spawnSyncImpl = (_cmd, args) => {
      spawnSyncCalls.push(args);
      if (args[0] === "list-sessions") return { status: 0, stdout: "maw-bg-job-1\t1\tsh\n", stderr: "" };
      if (args[0] === "capture-pane") return { status: 0, stdout: "last\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    await expect(bgImpl.bgAttach("job-1")).resolves.toBe(0);
    expect(spawnCalls.at(-1)).toEqual(["tmux", "switch-client", "-t", "maw-bg-job-1"]);
  });
});

describe("init vendor coverage", () => {
  test("chooseExistingAction defaults on unknown answers and cmdInit covers non-interactive parse/defaults", async () => {
    await expect(initImpl.chooseExistingAction(async () => "wat", "backup")).resolves.toBe("backup");
    await expect(initImpl.cmdInit({ args: ["--non-interactive"] })).resolves.toEqual({ ok: false, error: "parse failed" });

    parseResult = { ok: true, opts: { force: true, backup: false, token: undefined, federate: true, federationToken: undefined, node: "n", ghqRoot: "/g", peers: [] } };
    bootstrapThrows = true;
    const result = await initImpl.cmdInit({ args: ["--non-interactive"], writer: (m) => logs.push(m) });
    expect(result.ok).toBe(true);
    expect(logs.join("\n")).toContain("plugins.lock bootstrap skipped");
    expect(logs.join("\n")).toContain("federation token");
  });

  test("plugin lock rejects unknown schema and pins source-shaped entry artifacts", () => {
    const schema = pluginLock.validateSchema({ schema: 999, updated: "now", plugins: {} });
    expect(schema.ok).toBe(false);
    if (!schema.ok) expect(schema.error).toContain("migration: upgrade maw-js");

    const tarball = join(tmpRoot, "plugin.tgz");
    writeFileSync(tarball, "fake tarball");
    process.env.MAW_PLUGINS_LOCK = join(tmpRoot, "plugins.lock");
    pluginManifest = { version: "1.2.3", entry: "src/index.ts" };

    const pinned = pluginLock.pinPlugin("vendor/test", tarball, { signers: ["alice"] });

    expect(pinned.entry.version).toBe("1.2.3");
    expect(pinned.entry.sha256).toBe("sha256:" + "a".repeat(64));
    expect(pinned.entry.signers).toEqual(["alice"]);
    expect(hashFileCalls.at(-1)?.endsWith("/src/index.ts")).toBe(true);
    expect(readFileSync(process.env.MAW_PLUGINS_LOCK!, "utf-8")).toContain("vendor/test");
  });
});

describe("bud dry-run and finalize coverage", () => {
  test("cmdBud dry-run reports seed, scaffold-only, wake, and parent sync branches", async () => {
    await budImpl.cmdBud("child", { from: "parent", dryRun: true, seed: true });
    let out = logs.join("\n");
    expect(out).toContain("--seed: would bulk soul-sync from parent");
    expect(out).toContain("would wake child");
    expect(out).toContain("would add child to parent");

    logs = [];
    await budImpl.cmdBud("solo", { root: true, dryRun: true, scaffoldOnly: true });
    out = logs.join("\n");
    expect(out).toContain("root oracle — no parent");
    expect(out).toContain("scaffold-only: would stop before git commit/push");
  });

  test("finalizeBud covers blank parent, split failure, root sync skip, and local psi copy", async () => {
    const budRepoPath = join(tmpRoot, "bud");
    const psiDir = join(budRepoPath, "ψ");
    mkdirSync(psiDir, { recursive: true });
    mkdirSync(join(tmpRoot, "github.com", "org", "source", "ψ", "memory", "learnings"), { recursive: true });
    writeFileSync(join(tmpRoot, "github.com", "org", "source", "ψ", "memory", "learnings", "a.md"), "a");
    process.env.TMUX = "/tmp/tmux";
    splitThrows = true;

    await budWake.finalizeBud({
      name: "child", parentName: "parent", org: "org", budRepoName: "child-oracle", budRepoPath, psiDir, fleetFile: join(tmpRoot, "fleet.json"),
      opts: { repo: "org/source", split: true },
    });

    const out = logs.join("\n");
    expect(out).toContain("born blank — pull memory when ready");
    expect(out).toContain("split failed: split nope child");
    expect(out).toContain("copied local project ψ/ from org/source");
    expect(wakeCalls).toHaveLength(1);

    logs = [];
    await budWake.finalizeBud({ name: "root", parentName: null, org: "org", budRepoName: "root-oracle", budRepoPath, psiDir, fleetFile: "", opts: {} });
    expect(logs.join("\n")).toContain("root oracle — no parent sync_peers to update");
  });
});

describe("bud storage, repo, and from-repo coverage", () => {
  test("withPeersLock treats EPERM holder as alive and times out", () => {
    const peers = join(tmpRoot, "peers.json");
    writeFileSync(`${peers}.lock`, "12345");
    let now = 0;
    Date.now = () => { now += 6000; return now; };
    process.kill = (() => { const err: NodeJS.ErrnoException = new Error("eperm"); err.code = "EPERM"; throw err; }) as typeof process.kill;
    process.env.PEERS_FILE = peers;
    expect(() => peersStore.savePeers({ version: 1, peers: {} })).toThrow("peers lock timeout");
  });

  test("peers store returns empty on unreadable live path and clears stale tmp", () => {
    const dirPath = join(tmpRoot, "peers-as-dir.json");
    mkdirSync(dirPath);
    writeFileSync(`${dirPath}.tmp`, "stale");
    process.env.PEERS_FILE = dirPath;
    expect(peersStore.loadPeers()).toEqual({ version: 1, peers: {} });
    expect(existsSync(`${dirPath}.tmp`)).toBe(false);
  });

  test("ensureBudRepo returns existing predicted repo path without gh/ghq side effects", async () => {
    const existing = join(tmpRoot, "existing-oracle");
    mkdirSync(existing);
    await expect(budRepoReal.ensureBudRepo("org/existing-oracle", existing, "existing-oracle", "org")).resolves.toBe(existing);
    expect(logs.join("\n")).toContain("repo already exists");
  });

  test("from-repo planner/orchestrator and executor cover safe dry-run, seed/sync failures, and idempotent writes", async () => {
    const target = join(tmpRoot, "target");
    mkdirSync(join(target, ".git"), { recursive: true });
    writeFileSync(join(target, "CLAUDE.md"), "# Existing");
    writeFileSync(join(target, ".gitignore"), "node_modules\n");

    expect(fromRepo.looksLikeUrl("Soul-Brews-Studio/maw-js")).toBe(true);
    const plan = fromRepo.planFromRepoInjection({ target, stem: "sprout", isUrl: false, force: false, trackVault: true } as never);
    expect(fromRepo.formatPlan(plan)).toContain("Oracle scaffold plan");
    await fromRepo.cmdBudFromRepo({ target, stem: "sprout", isUrl: false, dryRun: true } as never);

    await fromRepoExec.applyFromRepoInjection(plan, { target, stem: "sprout", from: "parent", trackVault: true } as never, (m) => logs.push(m));
    expect(readFileSync(join(target, "CLAUDE.md"), "utf-8")).toContain(fromRepoExec.oracleMarkerBegin("sprout"));
    await fromRepoExec.applyFromRepoInjection(plan, { target, stem: "sprout", from: "parent", trackVault: true } as never, (m) => logs.push(m));
    expect(logs.join("\n")).toContain("already has oracle block");

    logs = [];
    await fromRepo.cmdBudFromRepo({ target, stem: "old", isUrl: false, force: true, seed: true, from: "explode", syncPeers: true, pr: true } as never);
    const out = logs.join("\n");
    expect(out).toContain("--seed failed: seed boom");
    expect(out).toContain("--sync-peers failed: peers boom");
    expect(out).toContain("fleet entry updated");
    expect(out).toContain("PR opened");
  });
});

describe("dream function entry coverage", () => {
  test("cmdDream help, unknown project, and speculate-empty paths are side-effect-light", async () => {
    await dreamImpl.cmdDream({ help: true } as never);
    expect(logs.join("\n")).toContain("usage: maw dream [flags]");

    logs = [];
    await dreamImpl.cmdDream({ speculate: true } as never);
    expect(logs.join("\n")).toContain("Morpheus");

    logs = [];
    await dreamImpl.cmdDream({ project: "missing" } as never);
    expect(logs.join("\n")).toContain("project \"missing\" not found");
  });
});
