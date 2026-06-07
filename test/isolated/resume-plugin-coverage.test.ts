/** Targeted isolated coverage for src/vendor/mpr-plugins/resume/impl.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const homeDir = mkdtempSync(join(tmpdir(), "maw-resume-home-"));
const parkedDir = join(homeDir, ".config/maw/parked");
const stateRoot = join(homeDir, ".maw-state");
const stateParkedDir = join(stateRoot, "parked");
process.env.MAW_STATE_DIR = stateRoot;
process.env.MAW_CONFIG_DIR = join(homeDir, ".config/maw");

let currentSession = "oracle";
let windows: Array<{ index: number; name: string }> = [];
let sendTextCalls: Array<{ target: string; text: string }> = [];
let logs: string[] = [];
let errors: string[] = [];

const original = {
  log: console.log,
  error: console.error,
};

function writeSnapshot(name: string, overrides: Partial<Record<string, unknown>> = {}) {
  const state = {
    window: name,
    session: "oracle",
    branch: "alpha",
    cwd: `/tmp/${name}`,
    lastCommit: "abc1234 useful work",
    dirtyFiles: ["src/dirty.ts"],
    note: "resume the thing",
    parkedAt: "2026-05-18T00:00:00.000Z",
    ...overrides,
  };
  mkdirSync(parkedDir, { recursive: true });
  writeFileSync(join(parkedDir, `${name}.json`), JSON.stringify(state, null, 2));
}

mock.module("os", () => ({
  homedir: () => homeDir,
}));

mock.module("maw-js/sdk", () => ({
  tmux: {
    run: async (...args: string[]) => {
      if (args.join(" ") === "display-message -p #S") return `${currentSession}\n`;
      throw new Error(`unexpected tmux.run ${args.join(" ")}`);
    },
    listWindows: async (session: string) => {
      expect(session).toBe(currentSession);
      return windows;
    },
    sendText: async (target: string, text: string) => {
      sendTextCalls.push({ target, text });
    },
  },
}));

const { cmdResume } = await import("../../src/vendor/mpr-plugins/resume/impl.ts?resume-plugin-coverage");

beforeEach(() => {
  rmSync(parkedDir, { recursive: true, force: true });
  rmSync(stateParkedDir, { recursive: true, force: true });
  logs = [];
  errors = [];
  sendTextCalls = [];
  currentSession = "oracle";
  windows = [
    { index: 1, name: "coding" },
    { index: 2, name: "review" },
  ];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = original.log;
  console.error = original.error;
});

describe("resume plugin coverage", () => {
  test("lists empty and populated parked snapshots", async () => {
    await cmdResume();
    expect(logs.join("\n")).toContain("no parked tabs");

    logs = [];
    writeSnapshot("coding");
    writeSnapshot("review", { dirtyFiles: [], note: "", branch: "" });

    await cmdResume();
    const out = logs.join("\n");
    expect(out).toContain("PARKED");
    expect(out).toContain("coding");
    expect(out).toContain("resume the thing");
    expect(out).toContain("1 dirty");
    expect(out).toContain("review");
    expect(out).toContain("(no note)");
    expect(out).toContain("no branch");
    expect(out).toContain("clean");
  });

  test("prefers state parked snapshots while still listing legacy config snapshots", async () => {
    mkdirSync(stateParkedDir, { recursive: true });
    writeFileSync(
      join(stateParkedDir, "stateful.json"),
      JSON.stringify({
        window: "stateful",
        session: "oracle",
        branch: "alpha",
        cwd: "/tmp/stateful",
        lastCommit: "",
        dirtyFiles: [],
        note: "state parked tab",
        parkedAt: "2026-05-18T00:00:00.000Z",
      }),
    );
    writeSnapshot("legacy");

    await cmdResume();

    const out = logs.join("\n");
    expect(out).toContain("stateful");
    expect(out).toContain("state parked tab");
    expect(out).toContain("legacy");
    expect(out).toContain("resume the thing");
  });

  test("resumes by current tmux window number and deletes the snapshot", async () => {
    writeSnapshot("review", {
      branch: "feature/review",
      lastCommit: "def5678 review work",
      dirtyFiles: ["a.ts", "b.ts"],
      note: "finish review",
    });

    await cmdResume("2");

    expect(sendTextCalls).toEqual([
      {
        target: "oracle:review",
        text: "Resuming parked work. Task: finish review Branch: feature/review Last commit: def5678 review work Dirty files: a.ts, b.ts Please /recap and continue where we left off.",
      },
    ]);
    expect(existsSync(join(parkedDir, "review.json"))).toBe(false);
    expect(logs.join("\n")).toContain("resumed");
    expect(logs.join("\n")).toContain("review");
  });

  test("resumes by exact or partial name with optional prompt parts omitted", async () => {
    writeSnapshot("feature-long", {
      session: "remote",
      branch: "",
      lastCommit: "",
      dirtyFiles: [],
      note: "",
    });

    await cmdResume("long");

    expect(sendTextCalls).toEqual([
      {
        target: "remote:feature-long",
        text: "Resuming parked work. Please /recap and continue where we left off.",
      },
    ]);
    expect(existsSync(join(parkedDir, "feature-long.json"))).toBe(false);
  });

  test("missing target reports the lookup miss and falls back to parked list", async () => {
    writeSnapshot("coding");

    await cmdResume("missing");

    expect(sendTextCalls).toEqual([]);
    expect(errors.join("\n")).toContain("no parked state for 'missing'");
    expect(logs.join("\n")).toContain("PARKED");
    expect(existsSync(join(parkedDir, "coding.json"))).toBe(true);
  });
});
