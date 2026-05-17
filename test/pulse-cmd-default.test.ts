/**
 * pulse-cmd.ts — default-suite coverage for Pulse board CLI commands.
 */
import { describe, expect, test } from "bun:test";
import { cmdPulseAdd, cmdPulseLs, pulseDeps, type PulseDeps, type PulseIssue } from "../src/commands/shared/pulse-cmd";

const issue = (number: number, title: string, labels: string[] = []): PulseIssue => ({
  number,
  title,
  labels: labels.map(name => ({ name })),
});

const out = (logs: string[]) => logs.join("\n");

function makeDeps(options: {
  hostResponses?: string[];
  hostThrowsOn?: (cmd: string, index: number) => boolean;
  thread?: { url: string; num: number; isNew: boolean };
  period?: string;
  today?: string;
  label?: string;
  wakeTarget?: string;
} = {}) {
  const logs: string[] = [];
  const hostCommands: string[] = [];
  const addTaskCalls: Array<{ repo: string; threadNum: number; period: string; issueNum: number; title: string; oracle?: string }> = [];
  const wakeCalls: Array<{ oracle: string; opts: { task?: string; wt?: string; prompt?: string } }> = [];
  const responses = [...(options.hostResponses ?? [])];

  const deps = pulseDeps({
    hostExec: async (cmd: string) => {
      const index = hostCommands.length;
      hostCommands.push(cmd);
      if (options.hostThrowsOn?.(cmd, index)) throw new Error(`host boom ${index}`);
      return responses.shift() ?? "";
    },
    cmdWake: async (oracle: string, opts: { task?: string; wt?: string; prompt?: string }) => {
      wakeCalls.push({ oracle, opts });
      return options.wakeTarget ?? `${oracle}-target`;
    },
    timePeriod: () => options.period ?? "morning",
    todayDate: () => options.today ?? "2026-05-17",
    todayLabel: () => options.label ?? "2026-05-17 (อาทิตย์)",
    findOrCreateDailyThread: async () => options.thread ?? { url: "https://github.com/laris-co/pulse-oracle/issues/100", num: 100, isNew: false },
    addTaskToPeriodComment: async (repo, threadNum, period, issueNum, title, oracle) => {
      addTaskCalls.push({ repo, threadNum, period, issueNum, title, oracle });
    },
    log: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); },
  } satisfies Partial<PulseDeps>);

  return { deps, logs, hostCommands, addTaskCalls, wakeCalls };
}

describe("pulseDeps", () => {
  test("exposes production defaults with safe overrides", () => {
    const hostExec = async () => "ok";
    const deps = pulseDeps({ hostExec });

    expect(deps.hostExec).toBe(hostExec);
    expect(typeof deps.cmdWake).toBe("function");
    expect(typeof deps.timePeriod).toBe("function");
    expect(typeof deps.todayDate).toBe("function");
    expect(typeof deps.todayLabel).toBe("function");
    expect(typeof deps.findOrCreateDailyThread).toBe("function");
    expect(typeof deps.addTaskToPeriodComment).toBe("function");
    expect(typeof deps.log).toBe("function");
  });
});

describe("cmdPulseAdd", () => {
  test("creates an issue, adds it to the period comment and board, then wakes the assigned oracle", async () => {
    const h = makeDeps({
      hostResponses: ["https://github.com/laris-co/pulse-oracle/issues/321"],
      period: "afternoon",
      wakeTarget: "54-mawjs:mawjs-oracle",
    });

    await cmdPulseAdd("Fix Nat's board", { oracle: "mawjs", wt: "board-fix" }, h.deps);

    expect(h.hostCommands[0]).toContain("gh issue create");
    expect(h.hostCommands[0]).toContain("-t 'Fix Nat'\\''s board'");
    expect(h.hostCommands[0]).toContain("-l 'oracle:mawjs'");
    expect(h.hostCommands[0]).toContain("Parent: #100");
    expect(h.addTaskCalls).toEqual([{ repo: "laris-co/pulse-oracle", threadNum: 100, period: "afternoon", issueNum: 321, title: "Fix Nat's board", oracle: "mawjs" }]);
    expect(h.hostCommands[1]).toBe("gh project item-add 6 --owner laris-co --url 'https://github.com/laris-co/pulse-oracle/issues/321'");
    expect(h.wakeCalls).toHaveLength(1);
    expect(h.wakeCalls[0].oracle).toBe("mawjs");
    expect(h.wakeCalls[0].opts.wt).toBe("board-fix");
    expect(h.wakeCalls[0].opts.prompt).toContain("issue #321");
    expect(out(h.logs)).toContain("issue #321 (afternoon)");
    expect(out(h.logs)).toContain("added to Master Board");
    expect(out(h.logs)).toContain("54-mawjs:mawjs-oracle");
  });

  test("warns when project add fails and skips wake when no oracle was assigned", async () => {
    const h = makeDeps({
      hostResponses: ["https://github.com/laris-co/pulse-oracle/issues/not-a-number"],
      hostThrowsOn: (_cmd, index) => index === 1,
    });

    await cmdPulseAdd("Unassigned task", {}, h.deps);

    expect(h.addTaskCalls[0].issueNum).toBe(0);
    expect(h.wakeCalls).toEqual([]);
    expect(out(h.logs)).toContain("could not add to project board");
  });
});

describe("cmdPulseLs", () => {
  const issues = [
    issue(10, "📅 2026-05-17 Daily Thread", ["daily-thread"]),
    issue(2, "P001 Build dashboard", ["oracle:dash"]),
    issue(5, "P002 Ship widget", ["oracle:widget"]),
    issue(3, "Old infra chore", ["oracle:ops"]),
    issue(4, "Another old tool"),
    issue(11, "Fix current bug", ["oracle:mawjs"]),
    issue(12, "Another active task"),
  ];

  test("renders projects, tools, active items, oracle labels, and open count", async () => {
    const h = makeDeps({ hostResponses: [JSON.stringify(issues)] });

    await cmdPulseLs({}, h.deps);

    const text = out(h.logs);
    expect(text).toContain("Pulse Board");
    expect(text).toContain("Projects (2)");
    expect(text).toContain("P001 Build dashboard");
    expect(text).toContain("dash");
    expect(text).toContain("Tools/Infra (2)");
    expect(text).toContain("Old infra chore");
    expect(text).toContain("Active Today (2)");
    expect(text).toContain("Fix current bug → mawjs");
    expect(text).toContain("Another active task → —");
    expect(text).toContain("6 open");
  });

  test("sync patches an existing Pulse Board Index comment", async () => {
    const h = makeDeps({
      hostResponses: [
        JSON.stringify(issues),
        JSON.stringify([{ id: "c1", body: "Pulse Board Index old" }]),
      ],
      today: "2026-05-17",
      label: "2026-05-17 (อาทิตย์)",
    });

    await cmdPulseLs({ sync: true }, h.deps);

    expect(h.hostCommands[1]).toContain("issues/10/comments");
    expect(h.hostCommands[2]).toContain("issues/comments/c1 -X PATCH");
    expect(h.hostCommands[2]).toContain("Pulse Board Index (2026-05-17");
    expect(h.hostCommands[2]).toContain("#2 P001 Build dashboard → dash");
    expect(h.hostCommands[2]).toContain("#11 Fix current bug → mawjs 🟡");
    expect(out(h.logs)).toContain("synced to daily thread #10");
  });

  test("sync creates an index comment when missing and reports missing daily thread", async () => {
    const create = makeDeps({ hostResponses: [JSON.stringify(issues), JSON.stringify([])] });
    await cmdPulseLs({ sync: true }, create.deps);

    expect(create.hostCommands[2]).toContain("issues/10/comments -f body=");
    expect(out(create.logs)).toContain("index posted to daily thread #10");

    const missing = makeDeps({ hostResponses: [JSON.stringify([issue(1, "No thread")])] });
    await cmdPulseLs({ sync: true }, missing.deps);

    expect(out(missing.logs)).toContain("No daily thread found for today");
  });
});
