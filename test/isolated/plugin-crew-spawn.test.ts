/**
 * `maw company crew spawn` — ISOLATED SUITE (kobo-358).
 *
 * Why isolated: crew spawn shells through @maw-js/sdk/hostExec for tmux, and
 * reads company/oracle config. Bun's mock.module is process-global, so this
 * belongs under test/isolated (mirrors tile.test.ts's hostExec-mock pattern —
 * no test in this repo spins up a real tmux session, see kobo-358 recon).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";

let commands: string[] = [];
let nextSplitPane = 1;
let nextWindowPane = 1;
let paneListForSession = "";
let bootTranscript: Record<string, string[]> = {}; // paneId -> queued capture-pane outputs (shift per poll)
let displayMessageBySession: Record<string, string> = {};
let throwOnListPanes = false;

function nextBootLine(paneId: string): string {
  const q = bootTranscript[paneId];
  if (!q || q.length === 0) return "";
  return q.shift() ?? "";
}

mock.module("maw-js/sdk", () => ({
  hostExec: async (cmd: string): Promise<string> => {
    commands.push(cmd);

    if (cmd.includes("tmux display-message") && cmd.includes("#{session_name}:#{window_index}.#{pane_index}")) {
      return "sess:0.0\n";
    }
    if (cmd.includes("tmux display-message") && cmd.includes("#{session_name}")) {
      return "sess\n";
    }
    if (throwOnListPanes && cmd.includes("tmux list-panes")) {
      throw new Error("no server running on socket");
    }
    if (cmd.includes("tmux list-panes")) {
      return paneListForSession;
    }
    if (cmd.includes("tmux new-window")) {
      const id = `%w${nextWindowPane++}`;
      bootTranscript[id] ??= [];
      return `${id}\n`;
    }
    if (cmd.includes("tmux split-window")) {
      const id = `%p${nextSplitPane++}`;
      return `${id}\n`;
    }
    if (cmd.includes("tmux capture-pane")) {
      const m = cmd.match(/-t '?([^' ]+)'?/);
      const paneId = m?.[1] ?? "";
      return nextBootLine(paneId);
    }
    if (cmd.includes("tmux kill-window") || cmd.includes("tmux kill-pane") || cmd.includes("tmux set-option")) {
      return "";
    }
    if (cmd.startsWith("maw hey")) {
      return "delivered\n";
    }
    return "";
  },
}));

mock.module("maw-js/config", () => ({
  loadConfig: () => ({ oracle: "patchwork" }),
}));

mock.module(join(import.meta.dir, "../../src/vendor/mpr-plugins/company/company-helpers"), () => ({
  loadCompany: (name: string) => (name === "kobo" ? { name: "kobo", departments: {} } : null),
}));

mock.module(join(import.meta.dir, "../../src/core/worklog/company-scope"), () => ({
  scopeOfOracle: () => ({ company: "kobo", dept: "core", lead: "patchwork" }),
}));

const { crewSpawn, DEFAULT_WORKER_MODEL, FALLBACK_WORKER_MODEL } = await import("../../src/vendor/mpr-plugins/crew/spawn");
const { isCrewOwnedPane, teardownCrewWindows } = await import("../../src/vendor/mpr-plugins/crew/teardown");

let homeDir: string;
let stateDir: string;
let logs: string[];
const emit = (l: string) => logs.push(l);

beforeEach(() => {
  commands = [];
  nextSplitPane = 1;
  nextWindowPane = 1;
  paneListForSession = "";
  bootTranscript = {};
  throwOnListPanes = false;
  logs = [];
  process.env.TMUX_PANE = "%front";
  process.env.CREW_SPAWN_POLL_MS = "1"; // test-only — keep poll loops fast (prod default 2000ms)

  homeDir = mkdtempSync(join(tmpdir(), "crew-spawn-home-"));
  process.env.HOME = homeDir;
  const contractsDir = join(homeDir, ".claude", "skills", "crew", "contracts");
  mkdirSync(contractsDir, { recursive: true });
  for (const role of ["conductor", "worker", "reviewer"]) {
    writeFileSync(join(contractsDir, `${role}.md`), `${role} for {{COMPANY}}/{{DEPT}}/{{BOARD}}`);
  }

  stateDir = mkdtempSync(join(tmpdir(), "crew-spawn-state-"));
  process.env.CREW_STATE_DIR = stateDir;
});

describe("crew teardown predicate (kobo-358)", () => {
  test("crew role tags (conductor/worker/worker-N/reviewer) are kill-eligible", () => {
    expect(isCrewOwnedPane("🎼 conductor", "some-window")).toBe(true);
    expect(isCrewOwnedPane("⚒ worker", "some-window")).toBe(true);
    expect(isCrewOwnedPane("⚒ worker-2", "some-window")).toBe(true);
    expect(isCrewOwnedPane("🔎 reviewer", "some-window")).toBe(true);
  });

  test("crew-workers window is kill-eligible even without a role tag", () => {
    expect(isCrewOwnedPane("", "crew-workers")).toBe(true);
  });

  test("front/coord tag is NEVER kill-eligible — front is the invoker, not crew-spawned", () => {
    expect(isCrewOwnedPane("🧭 coord", "some-window")).toBe(false);
  });

  test("unknown/untagged/non-crew panes default to protected (fail-closed)", () => {
    expect(isCrewOwnedPane("", "bash")).toBe(false);
    expect(isCrewOwnedPane("some-other-tool", "main")).toBe(false);
  });
});

describe("teardownCrewWindows (kobo-358)", () => {
  test("no leftover panes → ok, nothing killed", async () => {
    paneListForSession = "%front|||🧭 coord|||main\n";
    const r = await teardownCrewWindows({ protectPaneId: "%front" });
    expect(r.ok).toBe(true);
    expect(r.killed).toEqual([]);
  });

  test("kills leftover crew-tagged panes but protects the invoker + non-crew panes", async () => {
    paneListForSession = [
      "%front|||🧭 coord|||main",
      "%oldcond|||🎼 conductor|||main",
      "%oldworker|||⚒ worker|||crew-workers",
      "%bash|||||main",
    ].join("\n");
    const r = await teardownCrewWindows({ protectPaneId: "%front" });
    expect(r.ok).toBe(true);
    expect(r.killed.sort()).toEqual(["%oldcond", "%oldworker"].sort());
    expect(commands.some(c => c.includes("kill-pane -t '%front'"))).toBe(false);
    expect(commands.some(c => c.includes("kill-pane -t '%bash'"))).toBe(false);
  });

  test("fail-closed: list-panes throwing → refuses (does not proceed to kill anything)", async () => {
    throwOnListPanes = true;
    const r = await teardownCrewWindows({ protectPaneId: "%front" });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(commands.some(c => c.includes("kill-pane"))).toBe(false);
  });
});

describe("crewSpawn (kobo-358)", () => {
  test("no company arg → usage error, no tmux calls", async () => {
    const r = await crewSpawn(undefined, emit);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("usage");
    expect(commands.length).toBe(0);
  });

  test("company not found → clean error, NO partial spawn (zero tmux calls)", async () => {
    const r = await crewSpawn("nonexistent-co", emit);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not found");
    expect(commands.some(c => c.includes("tmux"))).toBe(false);
  });

  test("default worker model is the literal claude-sonnet-5 (kobo-358 Tony directive — no normalization)", () => {
    expect(DEFAULT_WORKER_MODEL).toBe("claude-sonnet-5");
    expect(FALLBACK_WORKER_MODEL).toBe("sonnet");
  });

  test("happy path: boots claude-sonnet-5 on first try, no fallback fires", async () => {
    paneListForSession = "%front|||🧭 coord|||main\n";
    bootTranscript = {}; // filled lazily by new-window handler; pre-seed after first spawn is tricky, so poll via queued lines keyed post-hoc
    // Seed a queue for the FIRST allocated worker pane id (%w1, since nextPane starts at 1 and
    // conductor/reviewer are split-window %p not %w — worker is the first new-window call).
    bootTranscript["%w1"] = ["", "claude code — bypass permissions on"];
    const r = await crewSpawn("kobo", emit);
    expect(r.ok).toBe(true);
    // exactly one new-window call (no retry/kill-window fired)
    const newWindowCalls = commands.filter(c => c.includes("tmux new-window"));
    expect(newWindowCalls.length).toBe(1);
    expect(newWindowCalls[0]).toContain("--model");
    expect(newWindowCalls[0]).toContain("claude-sonnet-5");
    expect(commands.some(c => c.includes("kill-window"))).toBe(false);
  });

  test("W0 layout: conductor splits off front (-h), reviewer splits off CONDUCTOR (-v) — front left-50 full-height, conductor/reviewer stacked right 25/25 (kobo-375)", async () => {
    paneListForSession = "%front|||🧭 coord|||main\n";
    bootTranscript["%w1"] = ["", "claude code — bypass permissions on"];
    const r = await crewSpawn("kobo", emit);
    expect(r.ok).toBe(true);
    const splitCalls = commands.filter(c => c.includes("tmux split-window"));
    expect(splitCalls.length).toBe(2);
    // conductor: -h -p 50 off front (front|conductor 50/50, explicit ratio not implicit default)
    expect(splitCalls[0]).toContain("split-window -h -p 50 -t '%front'");
    // reviewer: -v -p 50 off CONDUCTOR (not front) — stacks top/bottom on the right half,
    // not a 3rd column. conductor's returned pane-id is the first split-window result (%p1).
    expect(splitCalls[1]).toContain("split-window -v -p 50 -t '%p1'");
    expect(splitCalls[1]).not.toContain("split-window -h -t '%front'");
  });

  test("boot-fail → kills orphan window, retries with plain sonnet, poll-verifies retry", async () => {
    paneListForSession = "%front|||🧭 coord|||main\n";
    bootTranscript["%w1"] = ["not available for your account"]; // first (sonnet-5) attempt fails fast
    bootTranscript["%w2"] = ["", "claude code — bypass permissions on"]; // retry (plain sonnet) succeeds
    const r = await crewSpawn("kobo", emit);
    expect(r.ok).toBe(true);
    const newWindowCalls = commands.filter(c => c.includes("tmux new-window"));
    expect(newWindowCalls.length).toBe(2);
    expect(newWindowCalls[0]).toContain("claude-sonnet-5");
    expect(newWindowCalls[1]).toContain("--model");
    expect(newWindowCalls[1]).not.toContain("claude-sonnet-5");
    expect(newWindowCalls[1]).toContain("sonnet");
    expect(commands.some(c => c.includes("kill-window -t '%w1'"))).toBe(true);
  });

  test("double-fail (both models fail to boot) → surfaces via maw hey with a RESOLVED addr, not a bare pane-id", async () => {
    paneListForSession = "%front|||🧭 coord|||main\n";
    bootTranscript["%w1"] = ["not available for your account"];
    bootTranscript["%w2"] = ["not available for your account"];
    const r = await crewSpawn("kobo", emit);
    // double-fail does not hard-fail the whole spawn (pane stays up for manual recovery)
    expect(r.ok).toBe(true);
    const heyCalls = commands.filter(c => c.startsWith("maw hey"));
    expect(heyCalls.length).toBe(1);
    expect(heyCalls[0]).toContain("sess:0.0"); // resolved session:window.pane, not a bare %w2
    expect(heyCalls[0]).not.toContain("%w2 ");
    expect(logs.some(l => l.includes("double-fail"))).toBe(true);
  });

  test("contract asset missing → clean error before any tmux call", async () => {
    rmSync(join(homeDir, ".claude", "skills", "crew", "contracts", "worker.md"));
    const r = await crewSpawn("kobo", emit);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("contract asset missing");
    expect(commands.some(c => c.includes("tmux"))).toBe(false);
  });
});
