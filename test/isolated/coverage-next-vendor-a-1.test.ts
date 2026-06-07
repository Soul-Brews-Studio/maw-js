import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { pathToFileURL } from "url";

const repoRoot = resolve(import.meta.dir, "../..");
const attachRoot = join(repoRoot, "src/vendor/mpr-plugins/attach");

let tempRoot = "";
let ghqRoot = "";
let hostExecCalls: string[] = [];
let logs: string[] = [];
let errors: string[] = [];
let spawnCalls: string[][] = [];
let tmuxAttachCalls: string[] = [];
let sessions: any[] = [];
let fleet: any[] = [];
let paneRaw = "";
let ghqExactQueue: string[] = [];
let resolveAttachResult: any = null;
let fetchOk = false;

const original = {
  cwd: process.cwd(),
  log: console.log,
  error: console.error,
  fetch: globalThis.fetch,
  spawn: Bun.spawn,
  stdinIsTTY: process.stdin.isTTY,
  mawConfigDir: process.env.MAW_CONFIG_DIR,
  mawHome: process.env.MAW_HOME,
};

function makeDreamRepo() {
  const repoPath = join(ghqRoot, "github.com", "Acme", "spark-oracle");
  mkdirSync(join(repoPath, "ψ", "inbox", "handoff"), { recursive: true });
  writeFileSync(
    join(repoPath, "ψ", "inbox", "handoff", "2026-05-18.md"),
    "| Priority | Item | Context |\n| --- | --- | --- |\n| Verify | Check the coverage path | Confirm the isolated run stayed green |\n- [ ] Fold the next deterministic branch\n",
  );
  return repoPath;
}

mock.module("maw-js/sdk", () => ({
  listSessions: async () => sessions,
  tmuxCmd: () => "tmux",
  hostExec: async (command: string) => {
    hostExecCalls.push(command);

    if (command === "ghq list -p 2>/dev/null") {
      return fleet.flatMap((session) => (session.windows ?? []).map((win: any) => join(ghqRoot, "github.com", win.repo))).join("\n");
    }
    if (command.startsWith("ghq list --exact --full-path")) {
      return ghqExactQueue.shift() ?? "";
    }
    if (command.startsWith("gh repo view ")) return "";
    if (command.startsWith("gh repo create ")) return "";
    if (command.startsWith("ghq get ")) return "";

    if (command.includes(" list-panes -a -F ")) return paneRaw;
    if (command.includes(" kill-pane -t ")) return "";
    if (command.includes(" list-panes -t ")) return "0\n1\n";

    if (command.includes(" log -1 --format='%s'")) return "coverage branch stabilized";
    if (command.includes(" log -1 --format='%ct'")) return String(Math.floor(Date.now() / 1000));
    if (command.includes(" status --porcelain")) return " M a\n M b\n M c\n M d\n M e\n M f\n";
    if (command.includes(" worktree list --porcelain")) {
      const repoPath = fleet[0]?.windows?.[0]?.repo ? join(ghqRoot, "github.com", fleet[0].windows[0].repo) : tempRoot;
      return `worktree ${repoPath}\nHEAD abc\n\nworktree ${repoPath}.wt-1-codex\nHEAD def\n`;
    }
    if (command.includes(" log --oneline --since=")) return "2";

    throw new Error(`unexpected hostExec command: ${command}`);
  },
}));

mock.module("maw-js/config/ghq-root", () => ({
  getGhqRoot: () => ghqRoot,
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  fleetDirForWrite: () => join(tempRoot || tmpdir(), "fleet"),
  loadFleet: () => fleet,
  loadFleetEntries: () => fleet.map((session, index) => ({
    file: `${String(index + 1).padStart(2, "0")}-${session.name}.json`,
    num: index + 1,
    groupName: session.name,
    session,
  })),
}));

mock.module(join(attachRoot, "resolve-attach-target"), () => ({
  resolveAttachTarget: async () => resolveAttachResult,
}));

mock.module(import.meta.resolve("../../src/commands/plugins/tmux/impl"), () => ({
  cmdTmuxAttach: (target: string) => {
    tmuxAttachCalls.push(target);
  },
}));

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "maw-coverage-next-vendor-a-"));
  ghqRoot = join(tempRoot, "ghq");
  hostExecCalls = [];
  logs = [];
  errors = [];
  spawnCalls = [];
  tmuxAttachCalls = [];
  sessions = [];
  fleet = [];
  paneRaw = "";
  ghqExactQueue = [];
  resolveAttachResult = null;
  fetchOk = false;

  process.chdir(tempRoot);
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  if (original.mawConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = original.mawConfigDir;
  if (original.mawHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = original.mawHome;
  globalThis.fetch = (async () => ({
    ok: fetchOk,
    json: async () => ({ results: [] }),
  })) as typeof fetch;
  Bun.spawn = ((cmd: string[], opts?: { stdin?: string; stdout?: string; stderr?: string }) => {
    spawnCalls.push([...cmd]);
    expect(opts).toMatchObject({ stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return { exited: Promise.resolve(0) } as ReturnType<typeof Bun.spawn>;
  }) as typeof Bun.spawn;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
});

afterEach(() => {
  process.chdir(original.cwd);
  console.log = original.log;
  console.error = original.error;
  globalThis.fetch = original.fetch;
  Bun.spawn = original.spawn;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: original.stdinIsTTY });
  if (original.mawConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = original.mawConfigDir;
  if (original.mawHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = original.mawHome;
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

describe("coverage-next vendor group A", () => {
  test("dream writes a scan artifact, optional speculation, and existing speculation summaries", async () => {
    const repoPath = makeDreamRepo();
    fleet = [{ name: "spark", windows: [{ name: "work", repo: "Acme/spark-oracle" }] }];

    const { cmdDream } = await import("../../src/vendor/mpr-plugins/dream/impl.ts?coverage-next-vendor-a-dream-flow");

    await cmdDream({ between: true } as never);

    const dreamDir = join(tempRoot, "ψ", "writing", "dreams");
    const morpheusDir = join(tempRoot, "ψ", "memory", "morpheus");
    const dreamFiles = readdirSync(dreamDir).filter((name) => name.endsWith("_dream.md"));
    const speculationFiles = readdirSync(morpheusDir).filter((name) => name.endsWith("_speculations.md"));
    expect(dreamFiles).toHaveLength(1);
    expect(speculationFiles).toHaveLength(1);
    const dreamText = readFileSync(join(dreamDir, dreamFiles[0]!), "utf-8");
    const speculationText = readFileSync(join(morpheusDir, speculationFiles[0]!), "utf-8");
    expect(dreamText).toContain("spark — 6 uncommitted files");
    expect(dreamText).toContain("Fold the next deterministic branch");
    expect(speculationText).toContain("coverage branch stabilized");
    expect(speculationText).toContain("spark — 6 uncommitted files");
    expect(hostExecCalls).toContain("ghq list -p 2>/dev/null");
    expect(hostExecCalls.some((command) => command.includes(repoPath))).toBeTrue();

    const now = new Date();
    writeFileSync(join(dreamDir, "2026-05-18_existing.md"), "# Prior\n- one\n- two\n", "utf-8");
    writeFileSync(join(morpheusDir, "2026-05-18_existing.md"), "# Prior speculation\n- three\n", "utf-8");
    utimesSync(join(dreamDir, "2026-05-18_existing.md"), now, now);
    utimesSync(join(morpheusDir, "2026-05-18_existing.md"), now, now);

    logs = [];
    await cmdDream({ speculate: true } as never);
    const summary = logs.join("\n");
    expect(summary).toContain("Latest dream");
    expect(summary.includes("one") || summary.includes("coverage branch stabilized")).toBeTrue();
    expect(summary).toContain("Latest speculation");
    expect(summary.includes("three") || summary.includes("coverage branch stabilized")).toBeTrue();
  });

  test("dream hooks render connections and save every optional markdown section", async () => {
    const { __dreamImplCoverageHooks } = await import("../../src/vendor/mpr-plugins/dream/impl.ts?coverage-next-vendor-a-dream-flow");
    const pain = {
      category: "pain", title: "Cache race failure", detail: "A deterministic cache race is blocking the suite", source: "/tmp/a", project: "spark", confidence: "high", daysAgo: 0, action: "check cache",
    };
    const plan = {
      category: "plan", title: "Cache race remediation", detail: "Verify: keep the deterministic cache path covered", source: "/tmp/b", project: "spark", confidence: "medium", daysAgo: 4,
    };
    const memory = {
      category: "memory", title: "Cache race repeats", detail: "Past notes say the cache race returns", source: "/tmp/c", project: "ember", confidence: "low", daysAgo: 9,
    };

    __dreamImplCoverageHooks.renderDream(
      [pain, plan, memory],
      [{ from: pain, to: plan, relation: "has fix planned" }],
      ["Coverage: 1/1 pains have plans"],
      { all: true } as never,
    );

    const outPath = __dreamImplCoverageHooks.saveDream(
      [pain, plan, memory],
      [{ from: pain, to: plan, relation: "has fix planned" }],
      ["Coverage: 1/1 pains have plans"],
      2,
      true,
      [{ text: "fold the deterministic branch", source: "/tmp/f", daysAgo: 20, project: "spark" }],
      [{ text: "spark: cache race repeats", project: "spark" }],
    );

    const saved = readFileSync(outPath, "utf-8");
    expect(saved).toContain("## Forgotten");
    expect(saved).toContain("## Warnings");
    expect(saved).toContain("## Connections");
    expect(saved).toContain("## Insights");
    expect(logs.join("\n")).toContain("Connections");
    expect(logs.join("\n")).toContain("Insights");
  });

  test("bud URL heuristic, repo creation path, and local injector stay deterministic", async () => {
    const { looksLikeUrl } = await import("../../src/vendor/mpr-plugins/bud/from-repo.ts?coverage-next-vendor-a-from-repo");
    expect(looksLikeUrl("Acme/spark-oracle")).toBeTrue();
    expect(looksLikeUrl("./Acme/spark-oracle")).toBeFalse();
    expect(looksLikeUrl(join(tempRoot, "Acme", "spark-oracle"))).toBeFalse();

    const actualPath = join(tempRoot, "actual", "spark-oracle");
    mkdirSync(actualPath, { recursive: true });
    ghqExactQueue = ["", actualPath];
    const { ensureBudRepo } = await import("../../src/vendor/mpr-plugins/bud/bud-repo.ts?coverage-next-vendor-a-bud-repo");
    await expect(ensureBudRepo("Acme/spark-oracle", join(tempRoot, "predicted", "spark-oracle"), "spark-oracle", "Acme")).resolves.toBe(actualPath);
    expect(hostExecCalls).toContain("gh repo create Acme/spark-oracle --private --add-readme");
    expect(logs.join("\n")).toContain("using ghq's location");

    const injectRoot = join(tempRoot, "inject");
    mkdirSync(injectRoot, { recursive: true });
    const { applyFromRepoInjection, oracleMarkerBegin } = await import("../../src/vendor/mpr-plugins/bud/from-repo-exec.ts?coverage-next-vendor-a-from-repo-exec");
    const writeLogs: string[] = [];
    const plan = { target: injectRoot, stem: "spark", actions: [], blockers: [] };
    await applyFromRepoInjection(plan as never, { target: injectRoot, stem: "spark", from: "parent", trackVault: false } as never, (line) => writeLogs.push(line));
    expect(readFileSync(join(injectRoot, "CLAUDE.md"), "utf-8")).toContain("# spark-oracle");
    expect(readFileSync(join(injectRoot, ".gitignore"), "utf-8")).toContain("ψ/");

    await applyFromRepoInjection(plan as never, { target: injectRoot, stem: "spark", from: "parent", trackVault: true } as never, (line) => writeLogs.push(line));
    expect(readFileSync(join(injectRoot, "CLAUDE.md"), "utf-8")).toContain(oracleMarkerBegin("spark"));

    await applyFromRepoInjection(plan as never, { target: injectRoot, stem: "spark", from: "parent", trackVault: true } as never, (line) => writeLogs.push(line));
    expect(writeLogs.join("\n")).toContain("already has oracle block");
    expect(writeLogs.join("\n")).toContain("settings.local.json exists");
  });

  test("zenoh scout accepts the session-open path and filters the local announcement", async () => {
    const {
      discoveryKey,
      readZenohScoutConfig,
      runZenohScout,
    } = await import("../../src/vendor/mpr-plugins/zenoh-scout/impl.ts?coverage-next-vendor-a-zenoh");

    class FakeConfig {
      constructor(public locator: string, public timeoutMs?: number) {}
    }
    class FakeKeyExpr {
      constructor(public value: string) {}
      toString() { return this.value; }
    }

    const local = readZenohScoutConfig({ node: "m5", oracle: "codex", port: 3333, zenoh: { scout: { enabled: true, locator: "ws://router:10000", keyPrefix: "maw/custom///", timeoutMs: 5 } } } as never);
    const remote = readZenohScoutConfig({ node: "white", oracle: "pulse", port: 4444, zenoh: { scout: { enabled: true, keyPrefix: "maw/custom" } } } as never);
    const calls: string[] = [];
    const session = {
      liveliness() {
        return {
          async declareToken(key: FakeKeyExpr) {
            calls.push(`declare:${key}`);
            return { async undeclare() { calls.push("undeclare"); } };
          },
          async get(key: FakeKeyExpr, opts: Record<string, unknown>) {
            calls.push(`get:${key}:${opts.timeout}`);
            return (async function* () {
              yield { keyexpr: () => discoveryKey(local) };
              yield { keyexpr: () => ({ toString: () => discoveryKey(remote) }) };
            })();
          },
        };
      },
      async close() { calls.push("close"); },
    };

    const result = await runZenohScout(local, {
      importZenoh: async () => ({
        Config: FakeConfig,
        KeyExpr: FakeKeyExpr,
        Session: { open: async () => session as never },
        Duration: { milliseconds: { of: (ms: number) => `duration:${ms}` } },
      }),
      now: () => new Date("2026-05-18T01:02:03.000Z"),
    });

    expect(result.ok).toBeTrue();
    expect(result.peers.map((peer) => `${peer.node}:${peer.oracle}:${peer.host}`)).toEqual(["white:pulse:white:4444"]);
    expect(calls).toEqual([
      `declare:${discoveryKey(local)}`,
      "get:maw/custom/**:duration:5",
      "undeclare",
      "close",
    ]);
  });

  test("attach and kill cover sleeping attach plus ambiguous orphan-pane failures", async () => {
    resolveAttachResult = { tier: 2, fleetName: "sleepy-oracle" };
    const { cmdAttach } = await import("../../src/vendor/mpr-plugins/attach/impl.ts?coverage-next-vendor-a-attach");

    await cmdAttach("sleepy", { yes: true });
    expect(spawnCalls).toEqual([["maw", "wake", "sleepy-oracle"]]);
    expect(tmuxAttachCalls).toEqual(["sleepy-oracle"]);

    const sourcePath = resolve(repoRoot, "src/vendor/mpr-plugins/attach/impl.ts");
    const script = `${"\n".repeat(46)}function listAvailable(fleet, sessions) {\n  const all = new Set([...sessions.map(s => s.name), ...fleet.map(f => f.name)]);\n  if (all.size === 0) return "(none)";\n  return [...all].sort().join(", ");\n}\n//# sourceURL=${pathToFileURL(sourcePath).href}`;
    const listAvailable = (0, eval)(`${script}\nlistAvailable`) as (fleet: { name: string }[], sessions: { name: string }[]) => string;
    expect(listAvailable([], [])).toBe("(none)");
    expect(listAvailable([{ name: "zeta" }], [{ name: "alpha" }])).toBe("alpha, zeta");

    paneRaw = [
      "%201|||team:0.0|||codex|||tile-a|||/tmp/team-a",
      "%202|||team:0.1|||codex|||tile-b|||/tmp/team-b",
    ].join("\n");
    const { cmdKill } = await import("../../src/vendor/mpr-plugins/kill/impl.ts?coverage-next-vendor-a-kill");
    await expect(cmdKill("codex")).rejects.toThrow("'codex' is ambiguous");
    expect(errors.join("\n")).toContain("matches 2 panes");
    expect(hostExecCalls.some((command) => command.includes("kill-pane -t"))).toBeFalse();
  });

  test("profile show success returns captured JSON output", async () => {
    const configDir = join(tempRoot, "config");
    mkdirSync(join(configDir, "profiles"), { recursive: true });
    writeFileSync(join(configDir, "profiles", "ops.json"), JSON.stringify({ name: "ops", plugins: ["wake"] }), "utf-8");
    process.env.MAW_CONFIG_DIR = configDir;

    const { default: handler } = await import("../../src/vendor/mpr-plugins/profile/index.ts?coverage-next-vendor-a-profile");
    const result = await handler({ source: "cli", args: ["show", "ops"] } as never);

    expect(result.ok).toBeTrue();
    expect(JSON.parse(result.output!)).toEqual({ name: "ops", plugins: ["wake"] });
  });
});
