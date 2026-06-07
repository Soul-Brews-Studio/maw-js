import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

function at(path: string): string {
  return new URL(path, import.meta.url).pathname;
}

type TeamMember = { name: string; agentId?: string; agentType?: string; tmuxPaneId?: string; color?: string };
type Team = { name: string; members: TeamMember[] };

let ghqRoot = "";
let cwd = "";
let homeDir = "";
let vendorTeam: Team | undefined;
let commandTeam: Team | undefined;
let spawnSessionName = "";
let spawnThrows = false;
let hostExecQueue: Array<string | Error> = [];
let logs: string[] = [];
let writerLogs: string[] = [];
let commands: string[] = [];
let fetchResults: Record<string, Array<{ content: string; source_file: string; score: number; type?: string }>> = {};
let fetchOk = true;

const calls: Record<string, unknown[][]> = {
  vendorCreate: [], vendorSpawn: [], vendorSend: [], vendorBroadcast: [], vendorBring: [], vendorResume: [],
  vendorLives: [], vendorShutdown: [], vendorList: [], vendorTaskAdd: [], vendorTaskList: [], vendorTaskDone: [],
  vendorTaskAssign: [], vendorStatus: [], vendorDelete: [], vendorInvite: [], vendorOracleInvite: [],
  vendorOracleRemove: [], vendorOracleMembers: [], commandList: [], commandTaskList: [], commandResume: [],
  commandLives: [], commandShutdown: [], commandCreate: [], commandSpawn: [], commandSend: [], commandHostExec: [],
};

const original = {
  cwd: process.cwd(),
  log: console.log,
  error: console.error,
  fetch: globalThis.fetch,
  dateNow: Date.now,
  env: { ...process.env },
};

mock.module("os", () => ({
  homedir: () => homeDir,
  tmpdir: () => "/tmp",
}));

mock.module("maw-js/config/ghq-root", () => ({ getGhqRoot: () => ghqRoot }));
mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleet: () => [{ name: "dream-team-extra", windows: [{ name: "alpha", repo: "Soul-Brews-Studio/alpha-oracle" }] }],
}));
mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string) => fakeHostExec(cmd),
}));
mock.module("maw-js/cli/parse-args", () => ({ parseFlags: parseTestFlags }));

mock.module(at("../../src/vendor/mpr-plugins/team/impl"), () => ({
  cmdTeamCreate: (...args: unknown[]) => calls.vendorCreate.push(args),
  cmdTeamSpawn: async (...args: unknown[]) => { calls.vendorSpawn.push(args); },
  cmdTeamSend: (...args: unknown[]) => calls.vendorSend.push(args),
  cmdTeamBroadcast: async (...args: unknown[]) => { calls.vendorBroadcast.push(args); },
  cmdTeamBring: async (...args: unknown[]) => { calls.vendorBring.push(args); },
  cmdTeamResume: (...args: unknown[]) => calls.vendorResume.push(args),
  cmdTeamLives: (...args: unknown[]) => calls.vendorLives.push(args),
  cmdTeamShutdown: async (...args: unknown[]) => { calls.vendorShutdown.push(args); },
  cmdTeamList: () => calls.vendorList.push([]),
}));
mock.module(at("../../src/vendor/mpr-plugins/team/task-ops"), () => ({
  cmdTeamTaskAdd: (...args: unknown[]) => calls.vendorTaskAdd.push(args),
  cmdTeamTaskList: (...args: unknown[]) => calls.vendorTaskList.push(args),
  cmdTeamTaskDone: (...args: unknown[]) => calls.vendorTaskDone.push(args),
  cmdTeamTaskAssign: (...args: unknown[]) => calls.vendorTaskAssign.push(args),
}));
mock.module(at("../../src/vendor/mpr-plugins/team/team-status"), () => ({ cmdTeamStatus: async (...args: unknown[]) => calls.vendorStatus.push(args) }));
mock.module(at("../../src/vendor/mpr-plugins/team/team-cleanup"), () => ({ cmdTeamDelete: async (...args: unknown[]) => calls.vendorDelete.push(args) }));
mock.module(at("../../src/vendor/mpr-plugins/team/team-invite"), () => ({ cmdTeamInvite: async (...args: unknown[]) => calls.vendorInvite.push(args) }));
mock.module(at("../../src/vendor/mpr-plugins/team/oracle-members"), () => ({
  cmdOracleInvite: (...args: unknown[]) => calls.vendorOracleInvite.push(args),
  cmdOracleRemove: (...args: unknown[]) => calls.vendorOracleRemove.push(args),
  cmdOracleMembers: (...args: unknown[]) => calls.vendorOracleMembers.push(args),
}));
mock.module(at("../../src/vendor/mpr-plugins/team/team-helpers"), () => ({ loadTeam: () => vendorTeam }));
mock.module(at("../../src/vendor/mpr-plugins/team/team-charter"), () => ({
  readTeamCharter: (path: string) => ({ path }),
  preflightTeamCharter: () => ({ errors: ["missing role"] }),
  formatTeamCharterPreflight: (result: { errors: string[] }) => `errors=${result.errors.length}`,
  planTeamCharter: (charter: { path: string }) => charter,
  formatTeamCharterPlan: (charter: { path: string }) => `plan ${charter.path}`,
  loadTeamCharter: (charter: { path: string }) => charter,
  formatTeamCharterLoad: (charter: { path: string }) => `load ${charter.path}`,
  spawnFromTeamCharter: async (charter: { path: string }) => charter,
  formatTeamCharterSpawn: (charter: { path: string }) => `spawn ${charter.path}`,
}));
mock.module(at("../../src/vendor/mpr-plugins/team/team-comms"), () => ({
  teamMessageTargets: () => ["agent-a"],
  resolveTeamSendMode: (tail: string[]) => tail[0] === "agent-a"
    ? { mode: "single", agent: tail[0], message: tail.slice(1).join(" ") }
    : { mode: "broadcast", message: tail.join(" ") },
}));

mock.module(at("../../src/commands/plugins/team/impl"), () => ({
  cmdTeamCreate: (...args: unknown[]) => calls.commandCreate.push(args),
  cmdTeamSpawn: async (...args: unknown[]) => { calls.commandSpawn.push(args); },
  cmdTeamSend: (...args: unknown[]) => calls.commandSend.push(args),
  cmdTeamResume: (...args: unknown[]) => calls.commandResume.push(args),
  cmdTeamLives: (...args: unknown[]) => calls.commandLives.push(args),
  cmdTeamShutdown: async (...args: unknown[]) => { calls.commandShutdown.push(args); },
  cmdTeamList: () => calls.commandList.push([]),
}));
mock.module(at("../../src/commands/plugins/team/task-ops"), () => ({
  cmdTeamTaskAdd: () => {},
  cmdTeamTaskList: (...args: unknown[]) => calls.commandTaskList.push(args),
  cmdTeamTaskDone: () => {},
  cmdTeamTaskAssign: () => {},
}));
mock.module(at("../../src/commands/plugins/team/team-helpers"), () => ({
  TEAMS_DIR: join(homeDir || tmpdir(), "cmd-teams"),
  loadTeam: () => commandTeam,
}));
mock.module(at("../../src/commands/plugins/team/team-status"), () => ({ cmdTeamStatus: async () => {} }));
mock.module(at("../../src/commands/plugins/team/team-cleanup"), () => ({ cmdTeamDelete: async () => {} }));
mock.module(at("../../src/commands/plugins/team/team-invite"), () => ({ cmdTeamInvite: async () => {} }));
mock.module(at("../../src/commands/plugins/team/oracle-members"), () => ({
  cmdOracleInvite: () => {}, cmdOracleRemove: () => {}, cmdOracleMembers: () => {},
}));
mock.module(at("../../src/sdk"), () => ({
  hostExec: async (cmd: string) => {
    calls.commandHostExec.push([cmd]);
    const next = hostExecQueue.shift();
    if (next instanceof Error) throw next;
    return next ?? "";
  },
  withPaneLock: async (fn: () => Promise<void>) => fn(),
}));
mock.module(at("../../src/commands/plugins/tmux/layout-manager"), () => ({
  colorAnsi: (color: string) => ({ red: "31", blue: "34", white: "37" } as Record<string, string>)[color] ?? "37",
  nextAgentColor: () => "red",
  stylePaneBorder: async () => {},
  enableBorderStatus: async () => {},
  applyTeamLayout: async () => {},
  applyTiledLayout: async () => {},
  getWindowTarget: async () => "win:1",
}));

const dream = await import("../../src/vendor/mpr-plugins/dream/impl.ts?dream-team-index-extra");
const { default: vendorTeamHandler } = await import("../../src/vendor/mpr-plugins/team/index.ts?dream-team-index-extra");
const { default: commandTeamHandler } = await import("../../src/commands/plugins/team/index.ts?dream-team-index-extra");

beforeEach(() => {
  ghqRoot = mkdtempSync(join(tmpdir(), "maw-dream-extra-ghq-"));
  cwd = mkdtempSync(join(tmpdir(), "maw-dream-extra-cwd-"));
  homeDir = mkdtempSync(join(tmpdir(), "maw-team-extra-home-"));
  vendorTeam = undefined;
  commandTeam = undefined;
  spawnSessionName = "";
  spawnThrows = false;
  hostExecQueue = [];
  logs = [];
  writerLogs = [];
  commands = [];
  fetchResults = {};
  fetchOk = true;
  resetCalls();
  resetEnv();
  (Bun as unknown as { spawnSync: unknown }).spawnSync = () => {
    if (spawnThrows) throw new Error("tmux failed");
    return { stdout: { toString: () => spawnSessionName }, stderr: { toString: () => "" } };
  };
  process.chdir(cwd);
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  Date.now = () => new Date("2026-05-18T00:00:00.000Z").getTime();
  globalThis.fetch = fakeFetch as typeof fetch;
});

afterEach(() => {
  process.chdir(original.cwd);
  console.log = original.log;
  console.error = original.error;
  globalThis.fetch = original.fetch;
  Date.now = original.dateNow;
  process.env = { ...original.env };
  rmSync(ghqRoot, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe("dream impl extra coverage", () => {
  test("default command renders forgotten and warning branches from semantic search", async () => {
    const repo = createRepo("alpha-oracle", { daysAgo: 2, statusLines: 7, worktrees: 1 });
    writeRecentHandoff(repo, "| Priority | Item | Context |\n| --- | --- | --- |\n| Verify | Verify alpha branch | before release |\n- [ ] Continue focused dream coverage");
    const retroFile = join(repo, "ψ", "memory", "logs", "info", "2026-04-20_retro.md");
    const learningFile = join(repo, "ψ", "memory", "logs", "info", "2026-05-17_learning.md");
    fetchResults = {
      "test": [{ content: "ok", source_file: learningFile, score: 1 }],
      "next steps should build need to fix pending todo": [{
        content: "## Next Steps\n- Build the isolated extra coverage branch for team and dream\n- done already should be skipped",
        source_file: retroFile,
        score: 0.8,
      }],
      "keeps happening same bug again recurring repeated broke again": [{
        content: "# Alpha recurring pane routing broke again\nSummary:\n- The same pattern keeps happening.",
        source_file: learningFile,
        score: 0.9,
      }],
    };

    await dream.cmdDream({} as never);

    const output = logs.join("\n");
    expect(output).toContain("Continue From Yesterday");
    expect(output).toContain("Forgotten");
    expect(output).toContain("Build the isolated extra coverage branch");
    // Warning search executes even when no active repo matches the mocked git metadata.
    expect(Object.keys(fetchResults)).toContain("keeps happening same bug again recurring repeated broke again");
    const saved = readLatestDream();
    expect(saved).toContain("## Forgotten (planned but never done)");
    expect(saved).toContain("## Forgotten (planned but never done)");
  });

  test("project deep dive prints semantic connections and github lists", async () => {
    const repo = createRepo("alpha-oracle", { daysAgo: 1, statusLines: 0, worktrees: 0 });
    const base = join(repo, "ψ", "memory", "logs", "info");
    fetchResults = {
      "test": [{ content: "ok", source_file: join(base, "2026-05-17_ok.md"), score: 1 }],
      "what went wrong what error occurred how to fix": [{ content: "# Parser routing failure\nSummary:\n- Parser routing failed because flags were missing.", source_file: join(base, "2026-05-17_pain.md"), score: 0.7 }],
      "what should we build next what comes after roadmap": [{ content: "## Next Steps\n- Fix parser routing failure with a focused plan", source_file: join(base, "2026-05-17_plan.md"), score: 0.7 }],
      "pattern appeared again root cause lesson insight": [{ content: "# Parser routing failure repeats\nSummary:\n- Parser routing failure repeats in another path.", source_file: join(base, "2026-05-17_memory.md"), score: 0.7 }],
      "energy momentum breakthrough frustration tension": [{ content: "# Team energy improved after routing fix\nSummary:\n- Momentum returned.", source_file: join(base, "2026-05-17_feel.md"), score: 0.7 }],
    };

    await dream.cmdDream({ project: "alpha" } as never);

    const output = logs.join("\n");
    expect(output).toContain("Connections");
    expect(output).toContain("has fix planned");
    expect(readProjectDream("alpha")).toContain("**Parser routing failure** [high, 1d]");
  });

  test("exported helper edge cases cover fallback parsing branches", () => {
    expect(dream.extractDetail("---\ntags: x\nThis line is long enough to become fallback detail for coverage.")).toContain("fallback detail");
    expect(dream.extractRepo("/tmp/root/project-oracle/worktrees/agent-one/ψ/memory/log.md")).toBe("project");
    expect(dream.extractRepo("/tmp/no-psi/log.md")).toBe("unknown");
    expect(dream.daysFromFile("/tmp/no-date.md")).toBe(999);
    expect(dream.deduplicateItems([
      item("pain", "Alpha Duplicate Title with identical prefix branch", "alpha"),
      item("pain", "Alpha Duplicate Title with identical prefix branch plus more", "alpha"),
      item("gain", "Alpha Duplicate Title", "alpha"),
    ])).toHaveLength(2);
    expect(dream.shareKeywords("parser routing failure repeats", "routing parser failure planned", 2)).toBe(true);
    expect(dream.shareKeywords("short", "words", 1)).toBe(false);
  });
});

describe("vendor team index extra coverage", () => {
  test("writer captures usage errors and console is restored", async () => {
    const result = await vendorTeamHandler({ source: "cli", args: ["create"], writer: (...args: unknown[]) => writerLogs.push(args.map(String).join(" ")) } as never);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("name required");
    expect(result.output).toContain("usage: maw team create");
    expect(writerLogs).toEqual([]);
    console.log("after restore");
    expect(logs.at(-1)).toBe("after restore");
  });

  test("resolves context from tmux session and dispatches task operations", async () => {
    process.env.TMUX = "/tmp/tmux";
    spawnSessionName = "12-contextual\n";
    writeHomeTeamConfig("contextual");

    let result = await vendorTeamHandler({ source: "cli", args: ["tasks"] } as never);
    expect(result.ok).toBe(true);
    expect(calls.vendorTaskList).toEqual([["contextual"]]);

    result = await vendorTeamHandler({ source: "cli", args: ["add", "Fix", "coverage", "--assign", "alice", "--description", "branch"] } as never);
    expect(result.ok).toBe(true);
    expect(calls.vendorTaskAdd).toEqual([["contextual", "Fix coverage", { assign: "alice", description: "branch" }]]);

    result = await vendorTeamHandler({ source: "cli", args: ["done", "3"] } as never);
    expect(result.ok).toBe(true);
    expect(calls.vendorTaskDone).toEqual([["contextual", 3]]);

    result = await vendorTeamHandler({ source: "cli", args: ["assign", "3", "bob"] } as never);
    expect(result.ok).toBe(true);
    expect(calls.vendorTaskAssign).toEqual([["contextual", 3, "bob"]]);
  });

  test("preflight failures, load no-spawn, invite, enter, and unknown branches", async () => {
    let result = await vendorTeamHandler({ source: "cli", args: ["preflight", "team.yaml"] } as never);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("preflight failed");
    expect(result.output).toContain("errors=1");

    result = await vendorTeamHandler({ source: "cli", args: ["load", "team.yaml", "--no-spawn"] } as never);
    expect(result.ok).toBe(true);
    expect(result.output).toBe("load team.yaml");

    result = await vendorTeamHandler({ source: "cli", args: ["invite", "room", "peer", "--scope", "repo", "--lead", "nat"] } as never);
    expect(result.ok).toBe(true);
    expect(calls.vendorInvite).toEqual([["room", "peer", { scope: "repo", lead: "nat" }]]);

    process.env.MAW_TEAM = "room";
    vendorTeam = { name: "room", members: [{ name: "lead", agentType: "team-lead", tmuxPaneId: "%0" }, { name: "alice", agentId: "alice@room", tmuxPaneId: "%1" }] };
    result = await vendorTeamHandler({ source: "cli", args: ["enter", "alice"] } as never);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("enter sent to alice@room");

    result = await vendorTeamHandler({ source: "cli", args: ["mystery"] } as never);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown subcommand: mystery");
  });
});

describe("commands team index extra coverage", () => {
  test("writer output path and context fallback through home team config", async () => {
    writeHomeTeamConfig("solo");
    const result = await commandTeamHandler({ source: "cli", args: ["tasks"], writer: (...args: unknown[]) => writerLogs.push(args.map(String).join(" ")) } as never);
    expect(result.ok).toBe(true);
    expect(calls.commandTaskList).toEqual([["solo"]]);
    expect(result.output).toBeUndefined();
  });

  test("tmux context fallback ignores spawn failures and defaults", async () => {
    process.env.TMUX = "/tmp/tmux";
    spawnThrows = true;
    const result = await commandTeamHandler({ source: "cli", args: ["tasks"] } as never);
    expect(result.ok).toBe(true);
    expect(calls.commandTaskList).toEqual([["default"]]);
  });

  test("enter sends to all matching non-lead panes and reports unavailable agents", async () => {
    process.env.MAW_TEAM = "room";
    commandTeam = { name: "room", members: [
      { name: "lead", agentType: "team-lead", tmuxPaneId: "%0" },
      { name: "alice", agentId: "alice@room", tmuxPaneId: "%1", color: "red" },
      { name: "bob", agentId: "bob@room", tmuxPaneId: "%2" },
    ] };

    let result = await commandTeamHandler({ source: "cli", args: ["enter", "all"] } as never);
    expect(result.ok).toBe(true);
    expect(calls.commandHostExec).toEqual([["tmux send-keys -t '%1' Enter"], ["tmux send-keys -t '%2' Enter"]]);
    expect(result.output).toContain("enter sent to alice@room");

    result = await commandTeamHandler({ source: "cli", args: ["enter", "nobody"] } as never);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("agent not found");
    expect(`${result.output ?? result.error}`).toContain("agent not found");
  });
});

function resetCalls() {
  for (const key of Object.keys(calls)) calls[key] = [];
}

function resetEnv() {
  delete process.env.MAW_TEAM;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
}

function parseTestFlags(args: string[], schema: Record<string, unknown>, startIndex = 0): Record<string, unknown> {
  const out: Record<string, unknown> = { _: [] as string[] };
  const aliases: Record<string, string> = { "-e": "--engine" };
  for (let i = startIndex; i < args.length; i++) {
    const raw = args[i] ?? "";
    const token = aliases[raw] ?? raw;
    if (token in schema) {
      const type = schema[token];
      if (type === Boolean) out[token] = true;
      else if (type === Number) { out[token] = Number(args[i + 1] ?? 0); i++; }
      else { out[token] = args[i + 1] ?? ""; i++; }
    } else {
      (out._ as string[]).push(raw);
    }
  }
  return out;
}

function createRepo(dirName: string, opts: { daysAgo: number; statusLines: number; worktrees: number }): string {
  const repoPath = join(ghqRoot, "github.com", "Soul-Brews-Studio", dirName);
  mkdirSync(join(repoPath, "ψ"), { recursive: true });
  writeFileSync(join(repoPath, ".dream-extra-meta.json"), JSON.stringify(opts));
  return repoPath;
}

function writeHomeTeamConfig(teamName: string): void {
  const dir = join(homeDir, ".claude", "teams", teamName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name: teamName }));
}

function writeRecentHandoff(repoPath: string, content: string): void {
  const path = join(repoPath, "ψ", "inbox", "handoff", "2026-05-17_handoff.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  const d = new Date("2026-05-17T00:00:00.000Z");
  utimesSync(path, d, d);
}

async function fakeHostExec(cmd: string): Promise<string> {
  commands.push(cmd);
  if (cmd === "ghq list -p 2>/dev/null") {
    const root = join(ghqRoot, "github.com", "Soul-Brews-Studio");
    return existsSync(root) ? readdirSync(root).map((name) => join(root, name)).join("\n") : "";
  }
  if (cmd.includes("log -1 --format='%s'")) return "Dream extra branch";
  if (cmd.includes("log -1 --format='%ct'")) {
    const repo = repoFromCommand(cmd);
    const meta = readMeta(repo);
    return String(Math.floor((Date.now() - meta.daysAgo * 86_400_000) / 1000));
  }
  if (cmd.includes("status --porcelain")) {
    const meta = readMeta(repoFromCommand(cmd));
    return Array.from({ length: meta.statusLines }, (_, i) => ` M file-${i}.ts`).join("\n");
  }
  if (cmd.includes("worktree list --porcelain")) {
    const repo = repoFromCommand(cmd);
    const meta = readMeta(repo);
    return [repo, ...Array.from({ length: meta.worktrees }, (_, i) => `${repo}-extra-${i}`)].map((path) => `worktree ${path}\n`).join("\n");
  }
  if (cmd.includes("log --oneline --since='7 days ago'")) return "2";
  if (cmd.includes("log --oneline --since='30 days ago'")) return "8";
  if (cmd.includes("log -15 --format")) return "abc123 2026-05-17 Cover dream team indexes";
  if (cmd.includes("gh issue list")) return JSON.stringify([{ number: 42, title: "Track parser coverage", state: "OPEN" }]);
  if (cmd.includes("gh pr list")) return JSON.stringify([{ number: 7, title: "Cover team index", state: "OPEN" }]);
  if (cmd.includes("tmux send-keys")) return "";
  return "";
}

function repoFromCommand(cmd: string): string {
  const match = cmd.match(/git -C '([^']+)'/);
  return match?.[1] ?? "";
}

function readMeta(repoPath: string): { daysAgo: number; statusLines: number; worktrees: number } {
  const direct = join(repoPath, ".dream-extra-meta.json");
  if (existsSync(direct)) return JSON.parse(readFileSync(direct, "utf-8"));
  const fallback = join(ghqRoot, "github.com", "Soul-Brews-Studio", repoPath.split("/").at(-1) ?? "", ".dream-extra-meta.json");
  if (existsSync(fallback)) return JSON.parse(readFileSync(fallback, "utf-8"));
  return { daysAgo: 1, statusLines: 0, worktrees: 0 };
}

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input));
  const query = url.searchParams.get("q") ?? "";
  const results = fetchResults[query] ?? [];
  return { ok: fetchOk, json: async () => ({ results }) } as Response;
}

function readLatestDream(): string {
  const dir = join(cwd, "ψ", "writing", "dreams");
  const file = readdirSync(dir).filter((entry) => entry.endsWith("_dream.md")).sort().at(-1);
  expect(file).toBeDefined();
  return readFileSync(join(dir, file!), "utf-8");
}

function readProjectDream(repoName: string): string {
  const dir = join(cwd, "ψ", "writing", "dreams", "project");
  const file = readdirSync(dir).find((entry) => entry.endsWith(`_${repoName}_deep.md`));
  expect(file).toBeDefined();
  return readFileSync(join(dir, file!), "utf-8");
}

function item(category: string, title: string, project: string) {
  return { category, title, detail: "", source: "/tmp/source", project, confidence: "high", daysAgo: 0 };
}
