/**
 * Runtime coverage for the Pulse CLI helpers. GitHub, wake, and daily-thread
 * helpers are mocked so issue creation/listing/sync branches can be exercised
 * without network or tmux side effects.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let hostExecCalls: string[] = [];
let hostExecImpl: (cmd: string) => Promise<string> | string = () => "";
let wakeCalls: unknown[][] = [];
let addTaskCalls: unknown[][] = [];
let findThreadCalls: unknown[] = [];
let period = "morning";
let date = "2026-05-17";
let label = "17 May 2026";
let logs: string[] = [];

const originalLog = console.log;

mock.module(import.meta.resolve("../../src/sdk"), () => ({
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return await hostExecImpl(cmd);
  },
}));

mock.module(import.meta.resolve("../../src/commands/shared/wake"), () => ({
  cmdWake: async (...args: unknown[]) => {
    wakeCalls.push(args);
    return "mawjs-oracle";
  },
}));

mock.module(import.meta.resolve("../../src/commands/shared/pulse-thread"), () => ({
  timePeriod: () => period,
  todayDate: () => date,
  todayLabel: () => label,
  findOrCreateDailyThread: async (repo: string) => {
    findThreadCalls.push(repo);
    return { num: 77 };
  },
  addTaskToPeriodComment: async (...args: unknown[]) => {
    addTaskCalls.push(args);
  },
}));

const { cmdPulseAdd, cmdPulseLs } = await import("../../src/commands/shared/pulse-cmd.ts?pulse-cmd-runtime-coverage");

beforeEach(() => {
  hostExecCalls = [];
  hostExecImpl = () => "";
  wakeCalls = [];
  addTaskCalls = [];
  findThreadCalls = [];
  period = "morning";
  date = "2026-05-17";
  label = "17 May 2026";
  logs = [];
  console.log = (line?: unknown) => { logs.push(String(line ?? "")); };
});

afterEach(() => {
  console.log = originalLog;
});

const issue = (number: number, title: string, labels: string[] = []) => ({
  number,
  title,
  labels: labels.map((name) => ({ name })),
});

function pulseIssuesJson() {
  return JSON.stringify([
    issue(50, "Daily 2026-05-17", ["daily-thread"]),
    issue(11, "P001 Project Alpha", ["oracle:neo"]),
    issue(12, "P002 Project Beta", []),
    issue(30, "Tooling cleanup", []),
    issue(40, "Daily dashboard chore", ["oracle:ops"]),
    issue(60, "Fix live router", ["oracle:mawjs"]),
    issue(61, "Patch runtime bridge", []),
  ]);
}

describe("cmdPulseAdd", () => {
  test("creates a task, updates the period comment, adds to the board, and wakes the oracle", async () => {
    hostExecImpl = (cmd) => {
      if (cmd.startsWith("gh issue create")) return "https://github.com/laris-co/pulse-oracle/issues/123\n";
      if (cmd.startsWith("gh project item-add")) return "ok";
      throw new Error(`unexpected command: ${cmd}`);
    };

    await cmdPulseAdd("Bob's task", { oracle: "mawjs", wt: "wt-1" });

    expect(findThreadCalls).toEqual(["laris-co/pulse-oracle"]);
    expect(hostExecCalls[0]).toContain("gh issue create --repo laris-co/pulse-oracle");
    expect(hostExecCalls[0]).toContain("-t 'Bob'\\''s task'");
    expect(hostExecCalls[0]).toContain("-l 'oracle:mawjs'");
    expect(hostExecCalls[0]).toContain("Parent: #77");
    expect(addTaskCalls).toEqual([["laris-co/pulse-oracle", 77, "morning", 123, "Bob's task", "mawjs"]]);
    expect(hostExecCalls[1]).toBe("gh project item-add 6 --owner laris-co --url 'https://github.com/laris-co/pulse-oracle/issues/123'");
    expect(wakeCalls).toEqual([["mawjs", {
      wt: "wt-1",
      prompt: "/recap --deep — You have been assigned issue #123: Bob's task. Issue URL: https://github.com/laris-co/pulse-oracle/issues/123. Orient yourself, then wait for human instructions.",
    }]]);
    expect(logs.join("\n")).toContain("issue #123 (morning)");
    expect(logs.join("\n")).toContain("added to morning in daily thread #77");
    expect(logs.join("\n")).toContain("added to Master Board (#6)");
    expect(logs.join("\n")).toContain("mawjs-oracle: waking up");
  });

  test("keeps going when project add fails and no oracle wake is requested", async () => {
    hostExecImpl = (cmd) => {
      if (cmd.startsWith("gh issue create")) return "https://github.com/laris-co/pulse-oracle/issues/not-a-number";
      if (cmd.startsWith("gh project item-add")) throw new Error("project closed");
      throw new Error(`unexpected command: ${cmd}`);
    };

    await cmdPulseAdd("plain task", {});

    expect(hostExecCalls[0]).not.toContain("-l 'oracle:");
    expect(addTaskCalls).toEqual([["laris-co/pulse-oracle", 77, "morning", 0, "plain task", undefined]]);
    expect(wakeCalls).toEqual([]);
    expect(logs.join("\n")).toContain("warn:");
    expect(logs.join("\n")).toContain("project closed");
  });
});

describe("cmdPulseLs", () => {
  test("prints projects, tools, active work, oracle labels, and open count", async () => {
    hostExecImpl = (cmd) => {
      expect(cmd).toContain("gh issue list --repo laris-co/pulse-oracle");
      return pulseIssuesJson();
    };

    await cmdPulseLs({});

    const out = logs.join("\n");
    expect(out).toContain("📋 Pulse Board");
    expect(out).toContain("Projects (2)");
    expect(out).toContain("#11");
    expect(out).toContain("P001 Project Alpha");
    expect(out).toContain("neo");
    expect(out).toContain("Tools/Infra (2)");
    expect(out).toContain("#30");
    expect(out).toContain("#40");
    expect(out).toContain("ops");
    expect(out).toContain("Active Today (2)");
    expect(out).toContain("#60 Fix live router → mawjs");
    expect(out).toContain("6 open");
  });

  test("sync mode with no daily thread reports the missing thread", async () => {
    hostExecImpl = () => "   ";

    await cmdPulseLs({ sync: true });

    expect(hostExecCalls).toHaveLength(1);
    expect(logs.join("\n")).toContain("0 open");
    expect(logs.join("\n")).toContain("No daily thread found for today");
  });

  test("sync mode patches an existing Pulse Board Index comment", async () => {
    hostExecImpl = (cmd) => {
      if (cmd.startsWith("gh issue list")) return pulseIssuesJson();
      if (cmd.includes("/issues/50/comments")) return JSON.stringify([{ id: "c1", body: "Pulse Board Index old" }]);
      if (cmd.includes("/issues/comments/c1") && cmd.includes("-X PATCH")) return "patched";
      throw new Error(`unexpected command: ${cmd}`);
    };

    await cmdPulseLs({ sync: true });

    expect(hostExecCalls[1]).toBe("gh api repos/laris-co/pulse-oracle/issues/50/comments --jq '[.[] | {id: .id, body: .body}]'");
    expect(hostExecCalls[2]).toContain("gh api repos/laris-co/pulse-oracle/issues/comments/c1 -X PATCH -f body='");
    expect(hostExecCalls[2]).toContain("## 📋 Pulse Board Index (17 May 2026)");
    expect(hostExecCalls[2]).toContain("### Projects (2)");
    expect(hostExecCalls[2]).toContain("#60 Fix live router → mawjs 🟡");
    expect(hostExecCalls[2]).toContain("**6 open** — Homekeeper Oracle 🤖");
    expect(logs.join("\n")).toContain("synced to daily thread #50");
  });

  test("sync mode posts the index when no existing comment is present", async () => {
    hostExecImpl = (cmd) => {
      if (cmd.startsWith("gh issue list")) return pulseIssuesJson();
      if (cmd.includes("/issues/50/comments") && cmd.includes("--jq")) return "[]";
      if (cmd.includes("/issues/50/comments") && cmd.includes("-f body=")) return "posted";
      throw new Error(`unexpected command: ${cmd}`);
    };

    await cmdPulseLs({ sync: true });

    expect(hostExecCalls[2]).toContain("gh api repos/laris-co/pulse-oracle/issues/50/comments -f body='");
    expect(logs.join("\n")).toContain("index posted to daily thread #50");
  });
});
