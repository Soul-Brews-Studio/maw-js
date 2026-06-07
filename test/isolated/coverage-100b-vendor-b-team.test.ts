import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let psi = mkdtempSync(join(tmpdir(), "maw-coverage-100b-team-root-"));
let sentTargets: string[] = [];
let sendMode: "ok" | "exit" | "throw" = "ok";
let team: any = null;
let claim: any = { claimed: false, found: false, teammates: [] };
let logs: string[] = [];
let errors: string[] = [];
let hostExecs: string[] = [];
let paneSets: Array<Set<string>> = [];

mock.module("maw-js/core/fleet/validate", () => ({ assertValidOracleName: (name: string) => { if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("bad name"); } }));

mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/impl"), () => ({
  cmdTeamShutdown: async () => {},
  cmdTeamList: async () => {},
  cmdTeamCreate: () => {},
  cmdTeamSpawn: async () => {},
  cmdTeamSend: () => {},
  cmdTeamBroadcast: async () => {},
  cmdTeamBring: async () => {},
  cmdTeamResume: () => {},
  cmdTeamLives: () => {},
}));
mock.module("maw-js/commands/shared/comm-send", () => ({
  cmdSend: async (target: string) => {
    sentTargets.push(target);
    if (sendMode === "exit") process.exit();
    if (sendMode === "throw") throw new Error("send failed");
  },
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/team-helpers"), () => ({
  TEAMS_DIR: join(psi, ".claude", "teams"),
  resolvePsi: () => psi,
  loadTeam: () => team,
  loadTeamConfig: () => team,
  writeMessage: () => {},
  writeShutdownRequest: () => {},
  cleanupTeamDir: () => {},
  currentLeadSessionId: () => "new-session",
  claimOrphanedTeamLead: () => claim,
}));
mock.module("maw-js/sdk", () => ({
  tmux: {
    listPaneIds: async () => paneSets.shift() ?? new Set<string>(),
    killPane: async () => {},
  },
  hostExec: async (cmd: string) => { hostExecs.push(cmd); return ""; },
  curlFetch: async () => ({ ok: false, data: {} }),
  listSessions: async () => [],
  resolveTarget: () => null,
  Tmux: class {},
  FLEET_DIR: join(psi, "fleet"),
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/team/oracle-members"), () => ({
  loadOracleRegistry: () => ({ members: [{ oracle: "neo" }] }),
  cmdOracleInvite: () => {},
  cmdOracleRemove: () => {},
  cmdOracleMembers: () => {},
}));

const charter = await import("../../src/vendor/mpr-plugins/team/team-charter.ts?coverage-100b-team-charter");
const comms = await import("../../src/vendor/mpr-plugins/team/team-comms.ts?coverage-100b-team-comms");
const lifecycle = await import("../../src/vendor/mpr-plugins/team/team-lifecycle.ts?coverage-100b-team-lifecycle");
const reincarnation = await import("../../src/vendor/mpr-plugins/team/team-reincarnation.ts?coverage-100b-team-reincarnation");
const handler = (await import("../../src/vendor/mpr-plugins/team/index.ts?coverage-100b-team-index")).default;

const originalLog = console.log;
const originalError = console.error;

beforeEach(() => {
  mkdirSync(join(psi, ".claude", "teams"), { recursive: true });
  sentTargets = [];
  sendMode = "ok";
  team = null;
  claim = { claimed: false, found: false, teammates: [] };
  logs = [];
  errors = [];
  hostExecs = [];
  paneSets = [];
  console.log = (...parts: unknown[]) => logs.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

function cli(args: string[]) {
  return { source: "cli", args } as any;
}

describe("coverage-100b vendor-b team gaps", () => {
  test("team charter parser skips blank member lines and preflight flags existing artifacts", () => {
    const parsed = charter.parseTeamCharterText(`
name: alpha
members:

  - role: scout
    prompt: |
      line one

      line two
`, "inline");
    expect(parsed.members[0].prompt).toContain("line two");

    const plan = charter.planTeamCharter(parsed);
    mkdirSync(join(psi, ".claude", "teams", "alpha"), { recursive: true });
    writeFileSync(plan.artifacts[0], "{}");
    const preflight = charter.preflightTeamCharter(parsed);
    expect(preflight.errors.some((check) => check.label === "existing artifacts")).toBe(true);
  });

  test("team broadcast counts process.exit without code as failure and restores exit", async () => {
    team = { members: [{ name: "lead", agentType: "team-lead" }, { name: "neo", agentType: "codex" }] };
    sendMode = "exit";

    await expect(comms.cmdTeamBroadcast("alpha", "hello")).rejects.toThrow("broadcast partial failure: 0 delivered, 1 failed");
    expect(sentTargets).toEqual(["neo"]);
  });

  test("shutdown merge runs after graceful exits and resume prints claimed blank separator", async () => {
    team = { members: [{ name: "neo", agentType: "codex", tmuxPaneId: "%1" }] };
    paneSets = [new Set(["%1"]), new Set(), new Set()];
    await lifecycle.cmdTeamShutdown("alpha", { merge: true });
    expect(logs.join("\n")).toContain("team 'alpha' shut down (knowledge merged)");

    logs = [];
    claim = { claimed: true, oldLeadSessionId: "old-session-id", newLeadSessionId: "new-session-id", teammates: ["neo"] };
    const archive = join(psi, "memory", "mailbox", "teams", "alpha");
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, "manifest.json"), JSON.stringify({ members: [] }));
    reincarnation.cmdTeamResume("alpha");
    expect(logs.join("\n")).toContain("claimed orphaned team 'alpha'");
  });

  test("team dispatcher enter sends to matching pane and unknown subcommand reports usage", async () => {
    process.env.MAW_TEAM = "alpha";
    team = { members: [{ name: "neo", agentId: "neo@alpha", agentType: "codex", tmuxPaneId: "%9" }] };

    await expect(handler(cli(["enter", "neo"]))).resolves.toMatchObject({ ok: true });
    expect(hostExecs).toEqual(["tmux send-keys -t '%9' Enter"]);

    const unknown = await handler(cli(["wat"]));
    expect(unknown.ok).toBe(false);
    expect(unknown.output).toContain("unknown team subcommand: wat");
    delete process.env.MAW_TEAM;
  });
});
