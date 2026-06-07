/**
 * Default-suite coverage for `maw artifacts` command rendering.
 *
 * Keeps the mock gated so other default tests can still use the real
 * src/lib/artifacts module if this file runs in the same process.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const realArtifacts = await import("../src/lib/artifacts");

let mockActive = false;
let summaries: realArtifacts.ArtifactSummary[] = [];
let artifact: ReturnType<typeof realArtifacts.getArtifact> = null;
let listCalls: Array<string | undefined> = [];
let getCalls: Array<{ team: string; taskId: string }> = [];

mock.module(join(import.meta.dir, "../src/lib/artifacts"), () => ({
  ...realArtifacts,
  listArtifacts: (team?: string) => {
    if (!mockActive) return realArtifacts.listArtifacts(team);
    listCalls.push(team);
    return summaries;
  },
  getArtifact: (team: string, taskId: string) => {
    if (!mockActive) return realArtifacts.getArtifact(team, taskId);
    getCalls.push({ team, taskId });
    return artifact;
  },
}));

const { cmdArtifacts } = await import("../src/commands/shared/artifacts");

const origLog = console.log;
const origError = console.error;
const origExit = process.exit;

let logs: string[];
let errors: string[];
let exitCode: number | undefined;

async function runArtifacts(sub: string, args: string[] = [], flags: Record<string, any> = {}) {
  logs = [];
  errors = [];
  exitCode = undefined;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number): never => {
    exitCode = code ?? 0;
    throw new Error(`__exit__:${exitCode}`);
  };

  try {
    await cmdArtifacts(sub, args, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("__exit__")) throw error;
  } finally {
    console.log = origLog;
    console.error = origError;
    (process as unknown as { exit: typeof origExit }).exit = origExit;
  }
}

beforeEach(() => {
  mockActive = true;
  summaries = [];
  artifact = null;
  listCalls = [];
  getCalls = [];
  logs = [];
  errors = [];
  exitCode = undefined;
});

afterEach(() => {
  mockActive = false;
  console.log = origLog;
  console.error = origError;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
});

describe("maw artifacts command", () => {
  test("lists artifacts in a table and filters by team", async () => {
    summaries = [
      {
        team: "alpha-team",
        taskId: "7",
        status: "completed",
        owner: "oracle",
        files: 3,
        hasResult: true,
        subject: "Ship the artifact browser with a long subject that trims",
        createdAt: "2026-05-17T00:00:00.000Z",
      },
      {
        team: "alpha-team",
        taskId: "8",
        status: "in_progress",
        files: 1,
        hasResult: false,
        subject: "Still working",
        createdAt: "2026-05-17T00:00:01.000Z",
      },
    ];

    await runArtifacts("ls", ["alpha-team"]);

    expect(listCalls).toEqual(["alpha-team"]);
    const output = logs.join("\n");
    expect(output).toContain("TEAM");
    expect(output).toContain("TASK");
    expect(output).toContain("alpha-team");
    expect(output).toContain("completed");
    expect(output).toContain("in_progress");
    expect(output).toContain("oracle");
    expect(output).toContain("yes");
    expect(output).toContain("no");
    expect(exitCode).toBeUndefined();
  });

  test("list --json prints machine-readable summaries", async () => {
    summaries = [
      {
        team: "json-team",
        taskId: "1",
        status: "pending",
        files: 0,
        hasResult: false,
        subject: "JSON please",
        createdAt: "2026-05-17T00:00:00.000Z",
      },
    ];

    await runArtifacts("", [], { "--json": true });

    expect(listCalls).toEqual([undefined]);
    expect(JSON.parse(logs[0])).toEqual(summaries);
  });

  test("list prints an empty-state message including team filter", async () => {
    await runArtifacts("list", ["empty-team"]);

    expect(listCalls).toEqual(["empty-team"]);
    expect(logs).toEqual(["No artifacts found. (team: empty-team)"]);
  });

  test("gets an artifact with result and attachments", async () => {
    artifact = {
      meta: {
        team: "team-a",
        taskId: "42",
        subject: "Detailed artifact",
        status: "completed",
        owner: "builder",
        createdAt: "2026-05-17T01:00:00.000Z",
        updatedAt: "2026-05-17T02:00:00.000Z",
        commitHash: "abc123",
      },
      spec: "# Spec\n\nDo it.\n",
      result: "# Result\n\nDone.\n",
      attachments: ["report.txt", "screenshot.png"],
      dir: "/tmp/artifacts/team-a/42",
    };

    await runArtifacts("get", ["team-a", "42"]);

    expect(getCalls).toEqual([{ team: "team-a", taskId: "42" }]);
    const output = logs.join("\n");
    expect(output).toContain("Detailed artifact");
    expect(output).toContain("Team: team-a | Task: 42");
    expect(output).toContain("Owner: builder");
    expect(output).toContain("Commit: abc123");
    expect(output).toContain("Do it.");
    expect(output).toContain("Done.");
    expect(output).toContain("attachments (2)");
    expect(output).toContain("report.txt");
    expect(output).toContain("Dir: /tmp/artifacts/team-a/42");
  });

  test("get --json prints the full artifact payload", async () => {
    artifact = {
      meta: {
        team: "json-team",
        taskId: "9",
        subject: "Full JSON",
        status: "pending",
        createdAt: "2026-05-17T01:00:00.000Z",
        updatedAt: "2026-05-17T01:00:00.000Z",
      },
      spec: "Spec body",
      result: null,
      attachments: [],
      dir: "/tmp/artifacts/json-team/9",
    };

    await runArtifacts("show", ["json-team", "9"], { "--json": true });

    expect(getCalls).toEqual([{ team: "json-team", taskId: "9" }]);
    expect(JSON.parse(logs[0])).toEqual(artifact);
  });

  test("get renders the no-result branch", async () => {
    artifact = {
      meta: {
        team: "team-b",
        taskId: "5",
        subject: "Pending artifact",
        status: "pending",
        createdAt: "2026-05-17T03:00:00.000Z",
        updatedAt: "2026-05-17T03:00:00.000Z",
      },
      spec: "Needs work",
      result: null,
      attachments: [],
      dir: "/tmp/artifacts/team-b/5",
    };

    await runArtifacts("get", ["team-b", "5"]);

    const output = logs.join("\n");
    expect(output).toContain("(no result.md yet)");
    expect(output).not.toContain("attachments (");
  });

  test("get usage errors exit when team or task id is missing", async () => {
    await runArtifacts("get", ["team-only"]);

    expect(exitCode).toBe(1);
    expect(errors).toEqual(["usage: maw artifacts get <team> <task-id>"]);
    expect(getCalls).toEqual([]);
  });

  test("get missing artifact errors and exits", async () => {
    artifact = null;

    await runArtifacts("get", ["ghost-team", "404"]);

    expect(getCalls).toEqual([{ team: "ghost-team", taskId: "404" }]);
    expect(exitCode).toBe(1);
    expect(errors).toEqual(["artifact not found: ghost-team/404"]);
  });

  test("unknown subcommand prints command usage and exits", async () => {
    await runArtifacts("wat", []);

    expect(exitCode).toBe(1);
    expect(errors).toEqual(["usage: maw artifacts [ls|get] [team] [task-id] [--json]"]);
  });
});
