import { describe, expect, mock, test } from "bun:test";

type Ctx = { source: "cli"; args: string[]; writer: (...args: unknown[]) => void };
const calls: Array<{ name: string; args: unknown[] }> = [];

function emit(name: string, ...args: unknown[]) {
  calls.push({ name, args });
  console.error(`${name}:stderr:${args.map(String).join("|")}`);
  console.log(`${name}:stdout`);
}

function mockBoth(spec: string, factory: () => Record<string, unknown>) {
  mock.module(import.meta.resolve(spec), factory);
  mock.module(import.meta.resolve(`${spec}.ts`), factory);
}

mockBoth("../../src/vendor/mpr-plugins/broadcast/impl", () => ({ cmdBroadcast: async (m: string) => emit("broadcast", m) }));
mockBoth("../../src/vendor/mpr-plugins/completions/impl", () => ({ cmdCompletions: async (s?: string) => emit("completions", s ?? "") }));
mockBoth("../../src/vendor/mpr-plugins/find/impl", () => ({ cmdFind: async (q: string, o: unknown) => emit("find", q, JSON.stringify(o)) }));
mockBoth("../../src/vendor/mpr-plugins/locate/impl", () => ({ cmdLocate: async (o: string, opts: unknown) => emit("locate", o, JSON.stringify(opts)) }));
mockBoth("../../src/vendor/mpr-plugins/overview/impl", () => ({ cmdOverview: async (a: string[]) => emit("overview", a.join(",")) }));
mockBoth("../../src/vendor/mpr-plugins/run/impl", () => ({ parseRunArgs: (a: string[]) => ({ target: a[0], text: a.slice(1).join(" ") }), cmdRun: async (o: unknown) => emit("run", JSON.stringify(o)) }));
mockBoth("../../src/vendor/mpr-plugins/send/impl", () => ({ parseSendArgs: (a: string[]) => ({ target: a[0], text: a.slice(1).join(" ") }), cmdSend: async (o: unknown) => emit("send", JSON.stringify(o)) }));
mockBoth("../../src/vendor/mpr-plugins/send-text/impl", () => ({ parseSendTextArgs: (a: string[]) => ({ target: a[0], text: a.slice(1).join(" ") }), cmdSendText: async (o: unknown) => emit("send-text", JSON.stringify(o)) }));
mockBoth("../../src/vendor/mpr-plugins/send-enter/impl", () => ({ parseSendEnterArgs: (a: string[]) => ({ target: a[0], count: Number(a[1] ?? 1) }), cmdSendEnter: async (o: unknown) => emit("send-enter", JSON.stringify(o)) }));
mockBoth("../../src/vendor/mpr-plugins/shellenv/src/impl", () => ({ cmdShellenv: async (s: string, o: unknown) => emit("shellenv", s ?? "", JSON.stringify(o)) }));
mockBoth("../../src/vendor/mpr-plugins/soul-sync/impl", () => ({ cmdSoulSync: async (o?: string, opts?: unknown) => emit("soul-sync", o ?? "", JSON.stringify(opts ?? {})), cmdSoulSyncProject: async () => emit("soul-sync-project") }));
mockBoth("../../src/vendor/mpr-plugins/take/impl", () => ({ cmdTake: async (s: string, t?: string) => emit("take", s, t ?? "") }));
mock.module("maw-js/config", () => ({ D: {}, validateConfigShape: () => {}, loadConfig: () => ({ triggers: [] }), resetConfig: () => {}, saveConfig: (c: unknown) => emit("on", JSON.stringify(c)), configForDisplay: (c: unknown) => c, cfgInterval: (_c: unknown, _k: string, f = 0) => f, cfgTimeout: (_c: unknown, _k: string, f = 0) => f, cfgLimit: (_c: unknown, _k: string, f = 0) => f, cfg: (_c: unknown, _k: string, f: unknown) => f, buildCommand: (c: string) => c, buildCommandInDir: (_d: string, c: string) => c, getEnvVars: () => ({}) }));
mockBoth("../../src/vendor/mpr-plugins/project/impl", () => ({ stubLearn: async (u: string) => (emit("project", "learn", u), "learned"), stubIncubate: async (u: string) => (emit("project", "incubate", u), "incubated"), stubFind: async (q: string) => (emit("project", "find", q), "found"), stubList: async () => (emit("project", "list"), "listed"), helpText: () => "project help" }));
mockBoth("../../src/vendor/mpr-plugins/restart/impl", () => ({ cmdRestart: async (o: unknown) => emit("restart", JSON.stringify(o)) }));
mockBoth("../../src/vendor/mpr-plugins/talk-to/impl", () => ({ cmdTalkTo: async (a: string, m: string, f: boolean) => emit("talk-to", a, m, f) }));
mockBoth("../../src/vendor/mpr-plugins/cleanup/internal/team-cleanup-zombies", () => ({ cmdCleanupZombies: async (o: unknown) => emit("cleanup-zombies", JSON.stringify(o)) }));
mockBoth("../../src/vendor/mpr-plugins/cleanup/internal/prune-stale-oracles", () => ({ cmdPruneStale: async (o: unknown) => emit("cleanup-prune", JSON.stringify(o)) }));
mockBoth("../../src/vendor/mpr-plugins/learn/impl", () => ({ cmdLearn: async (r: string, m: string) => (emit("learn", r, m), "learned") }));
mock.module("maw-js/commands/shared/wake", () => ({ cmdWake: async (o: string, opts: unknown) => emit("wake", o, JSON.stringify(opts)), fetchIssuePrompt: async (n: number) => `issue-${n}`, fetchGitHubPrompt: async (k: string, n: number) => `${k}-${n}`, findWorktrees: async () => [], detectSession: async () => null, resolveFleetSession: () => null, isPaneIdle: async () => false, ensureSessionRunning: async () => {} }));
mock.module("maw-js/commands/shared/fleet", () => ({ cmdWakeAll: async (o: unknown) => emit("wake-all", JSON.stringify(o)) }));
mock.module("maw-js/commands/shared/wake-target", () => ({ parseWakeTarget: () => null, ensureCloned: async () => {} }));
mock.module("maw-js/commands/shared/wake-resolve", () => ({ fetchGitHubPrompt: async (k: string, n: number) => `${k}-${n}` }));
mockBoth("../../src/vendor/mpr-plugins/profile/impl", () => ({ cmdList: () => [{ name: "default" }], cmdCurrent: () => "default", formatList: (r: unknown[], a: string) => (emit("profile", r.length, a), "profiles"), cmdUse: (name: string) => ({ name }), cmdShow: (name: string) => ({ name }) }));
mockBoth("../../src/vendor/mpr-plugins/trust/impl", () => ({ cmdList: () => [], formatList: (r: unknown[]) => (emit("trust", r.length), "trusts"), cmdAdd: (s: string, t: string) => ({ added: true, entry: { sender: s, target: t, addedAt: "now" } }), cmdRemove: (s: string, t: string) => ({ sender: s, target: t }) }));
mock.module("maw-js/commands/shared/workspace", () => ({ cmdWorkspaceCreate: async (n: string, h?: string) => emit("workspace-create", n, h ?? ""), cmdWorkspaceJoin: async (c: string, h?: string) => emit("workspace-join", c, h ?? ""), cmdWorkspaceShare: async (a: string[], ws?: string) => emit("workspace-share", a.join(","), ws ?? ""), cmdWorkspaceUnshare: async (a: string[], ws?: string) => emit("workspace-unshare", a.join(","), ws ?? ""), cmdWorkspaceLs: async () => emit("workspace-ls"), cmdWorkspaceAgents: async (ws?: string) => emit("workspace-agents", ws ?? ""), cmdWorkspaceInvite: async (ws?: string) => emit("workspace-invite", ws ?? ""), cmdWorkspaceLeave: async (ws?: string) => emit("workspace-leave", ws ?? ""), cmdWorkspaceStatus: async () => emit("workspace-status") }));
mockBoth("../../src/vendor/mpr-plugins/scope/impl", () => ({ cmdList: () => [], formatList: (r: unknown[]) => (emit("scope", r.length), "scopes"), cmdCreate: ({ name, members }: { name: string; members: string[] }) => ({ name, members }), scopePath: (n: string) => `/tmp/${n}`, cmdShow: (n: string) => ({ name: n }), cmdDelete: () => true }));
mockBoth("../../src/vendor/mpr-plugins/team/impl", () => ({ cmdTeamShutdown: async (t: string, o: unknown) => emit("team-shutdown", t, JSON.stringify(o)), cmdTeamList: async () => emit("team-list"), cmdTeamCreate: (t: string, o: unknown) => emit("team-create", t, JSON.stringify(o)), cmdTeamSpawn: async (t: string, r: string, o: unknown) => emit("team-spawn", t, r, JSON.stringify(o)), cmdTeamSend: (t: string, a: string, m: string) => emit("team-send", t, a, m), cmdTeamBroadcast: async (t: string, m: string) => emit("team-broadcast", t, m), cmdTeamBring: async (t: string, o: unknown) => emit("team-bring", t, JSON.stringify(o)), cmdTeamResume: (t: string, o: unknown) => emit("team-resume", t, JSON.stringify(o)), cmdTeamLives: (a: string) => emit("team-lives", a) }));
mockBoth("../../src/vendor/mpr-plugins/team/team-comms", () => ({ teamMessageTargets: () => [], resolveTeamSendMode: () => ({ mode: "broadcast", message: "hello" }) }));
mockBoth("../../src/vendor/mpr-plugins/team/task-ops", () => ({ cmdTeamTaskList: (t: string) => emit("team-task-list", t), cmdTeamTaskAdd: (t: string, s: string) => emit("team-task-add", t, s), cmdTeamTaskDone: (t: string, id: number) => emit("team-task-done", t, id), cmdTeamTaskAssign: (t: string, id: number, a: string) => emit("team-task-assign", t, id, a) }));
mockBoth("../../src/vendor/mpr-plugins/view/impl", () => ({ cmdView: async (a: string, w: string, c: boolean, k: boolean, s: unknown, o: unknown) => emit("view", a, w ?? "", c, k, String(s), JSON.stringify(o)) }));

const m = {
  broadcast: await import("../../src/vendor/mpr-plugins/broadcast/index.ts?owned-wrapper-stderr-coverage"), completions: await import("../../src/vendor/mpr-plugins/completions/index.ts?owned-wrapper-stderr-coverage"), find: await import("../../src/vendor/mpr-plugins/find/index.ts?owned-wrapper-stderr-coverage"), locate: await import("../../src/vendor/mpr-plugins/locate/index.ts?owned-wrapper-stderr-coverage"), overview: await import("../../src/vendor/mpr-plugins/overview/index.ts?owned-wrapper-stderr-coverage"), run: await import("../../src/vendor/mpr-plugins/run/index.ts?owned-wrapper-stderr-coverage"), send: await import("../../src/vendor/mpr-plugins/send/index.ts?owned-wrapper-stderr-coverage"), sendText: await import("../../src/vendor/mpr-plugins/send-text/index.ts?owned-wrapper-stderr-coverage"), sendEnter: await import("../../src/vendor/mpr-plugins/send-enter/index.ts?owned-wrapper-stderr-coverage"), shellenv: await import("../../src/vendor/mpr-plugins/shellenv/src/index.ts?owned-wrapper-stderr-coverage"), soulSync: await import("../../src/vendor/mpr-plugins/soul-sync/index.ts?owned-wrapper-stderr-coverage"), take: await import("../../src/vendor/mpr-plugins/take/index.ts?owned-wrapper-stderr-coverage"), on: await import("../../src/vendor/mpr-plugins/on/index.ts?owned-wrapper-stderr-coverage"), project: await import("../../src/vendor/mpr-plugins/project/index.ts?owned-wrapper-stderr-coverage"), restart: await import("../../src/vendor/mpr-plugins/restart/index.ts?owned-wrapper-stderr-coverage"), talkTo: await import("../../src/vendor/mpr-plugins/talk-to/index.ts?owned-wrapper-stderr-coverage"), cleanup: await import("../../src/vendor/mpr-plugins/cleanup/index.ts?owned-wrapper-stderr-coverage"), learn: await import("../../src/vendor/mpr-plugins/learn/index.ts?owned-wrapper-stderr-coverage"), wake: await import("../../src/vendor/mpr-plugins/wake/index.ts?owned-wrapper-stderr-coverage"), profile: await import("../../src/vendor/mpr-plugins/profile/index.ts?owned-wrapper-stderr-coverage"), trust: await import("../../src/vendor/mpr-plugins/trust/index.ts?owned-wrapper-stderr-coverage"), workspace: await import("../../src/vendor/mpr-plugins/workspace/index.ts?owned-wrapper-stderr-coverage"), scope: await import("../../src/vendor/mpr-plugins/scope/index.ts?owned-wrapper-stderr-coverage"), team: await import("../../src/vendor/mpr-plugins/team/index.ts?owned-wrapper-stderr-coverage"), view: await import("../../src/vendor/mpr-plugins/view/index.ts?owned-wrapper-stderr-coverage"),
};
const ctx = (args: string[], writer: (...args: unknown[]) => void): Ctx => ({ source: "cli", args, writer });

describe("owned vendor wrapper console.error writer coverage", () => {
  test("routes stderr through ctx.writer for each owned thin wrapper", async () => {
    const written: string[] = [];
    const writer = (...args: unknown[]) => written.push(args.map(String).join(" "));
    const cases: Array<[string, () => Promise<any>]> = [["broadcast", () => m.broadcast.default(ctx(["hello", "all"], writer))], ["completions", () => m.completions.default(ctx(["zsh"], writer))], ["find", () => m.find.default(ctx(["needle", "--oracle", "neo"], writer))], ["locate", () => m.locate.default(ctx(["neo", "--path"], writer))], ["overview", () => m.overview.default(ctx(["--json"], writer))], ["run", () => m.run.default(ctx(["neo", "echo", "hi"], writer))], ["send", () => m.send.default(ctx(["neo", "raw"], writer))], ["send-text", () => m.sendText.default(ctx(["neo", "line"], writer))], ["send-enter", () => m.sendEnter.default(ctx(["neo", "2"], writer))], ["shellenv", () => m.shellenv.default(ctx(["zsh"], writer))], ["soul-sync", () => m.soulSync.default(ctx(["neo"], writer))], ["take", () => m.take.default(ctx(["src:1", "dst"], writer))], ["on", () => m.on.default(ctx(["neo", "agent-idle", "echo", "ok"], writer))], ["project", () => m.project.default(ctx(["learn", "https://example/repo"], writer))], ["restart", () => m.restart.default(ctx(["--no-update"], writer) as any)], ["talk-to", () => m.talkTo.default(ctx(["neo", "hello"], writer))], ["cleanup-zombies", () => m.cleanup.default(ctx(["--zombies", "--yes"], writer))], ["learn", () => m.learn.default(ctx(["Soul-Brews-Studio/maw-js", "--fast"], writer))], ["wake", () => m.wake.default(ctx(["neo", "task"], writer))], ["profile", () => m.profile.default(ctx(["list"], writer))], ["trust", () => m.trust.default(ctx(["list"], writer))], ["workspace-ls", () => m.workspace.default(ctx(["ls"], writer))], ["scope", () => m.scope.default(ctx(["list"], writer))], ["team-list", () => m.team.default(ctx(["list"], writer))], ["view", () => m.view.default(ctx(["neo", "main", "--split=%1"], writer))]];
    for (const [name, run] of cases) await expect(run(), name).resolves.toMatchObject({ ok: true });
    for (const expected of cases.map(([name]) => name)) expect(written.some((line) => line.includes(`${expected}:stderr`)), expected).toBe(true);
  });

  test("team task context uses MAW_TEAM without touching real team directories", async () => {
    const written: string[] = [];
    process.env.MAW_TEAM = "env-team";
    await expect(m.team.default(ctx(["tasks"], (...args) => written.push(args.map(String).join(" "))))).resolves.toMatchObject({ ok: true });
    expect(calls).toContainEqual({ name: "team-task-list", args: ["env-team"] });
    expect(written).toContain("team-task-list:stderr:env-team");
    delete process.env.MAW_TEAM;
  });
});
