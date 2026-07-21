/**
 * `maw company head spawn` — ISOLATED SUITE (kobo-364).
 *
 * Why isolated: head spawn shells through @maw-js/sdk/hostExec for tmux, and
 * reads company/oracle config. Bun's mock.module is process-global, so this
 * belongs under test/isolated (mirrors plugin-crew-spawn.test.ts's
 * hostExec-mock pattern — no test in this repo spins up a real tmux session).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";

let commands: string[] = [];
let nextSplitPane = 1;
let paneListForSession = "";
let bootTranscript: Record<string, string[]> = {}; // paneId -> queued capture-pane outputs (shift per poll)
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
    if (cmd.includes("tmux split-window")) {
      const id = `%p${nextSplitPane++}`;
      bootTranscript[id] ??= [];
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
  loadConfig: () => ({ oracle: "eq3" }),
}));

mock.module(join(import.meta.dir, "../../src/vendor/mpr-plugins/company/company-helpers"), () => ({
  loadCompany: (name: string) => (name === "kobo" ? { name: "kobo", manager: "eq3", teams: {} } : null),
}));

mock.module(join(import.meta.dir, "../../src/core/worklog/company-scope"), () => ({
  scopeOfOracle: () => ({ company: "kobo", dept: null, lead: null }),
}));

const { headSpawn } = await import("../../src/vendor/mpr-plugins/head/spawn");

let homeDir: string;
let stateDir: string;
let logs: string[];
const emit = (l: string) => logs.push(l);

beforeEach(() => {
  commands = [];
  nextSplitPane = 1;
  paneListForSession = "";
  bootTranscript = {};
  throwOnListPanes = false;
  logs = [];
  process.env.TMUX_PANE = "%lead";
  process.env.HEAD_SPAWN_POLL_MS = "1"; // test-only — keep poll loops fast (prod default 2000ms)

  homeDir = mkdtempSync(join(tmpdir(), "head-spawn-home-"));
  process.env.HOME = homeDir;
  const contractsDir = join(homeDir, ".claude", "skills", "head", "contracts");
  mkdirSync(contractsDir, { recursive: true });
  for (const role of ["conductor", "reviewer"]) {
    writeFileSync(join(contractsDir, `${role}.md`), `${role} for {{COMPANY}}/{{DEPT}}/{{BOARD}}`);
  }

  stateDir = mkdtempSync(join(tmpdir(), "head-spawn-state-"));
  process.env.CREW_STATE_DIR = stateDir;
});

describe("headSpawn (kobo-364)", () => {
  test("no company arg → usage error, no tmux calls", async () => {
    const r = await headSpawn(undefined, emit);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("usage");
    expect(commands.length).toBe(0);
  });

  test("company not found → clean error, NO partial spawn (zero tmux calls)", async () => {
    const r = await headSpawn("nonexistent-co", emit);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not found");
    expect(commands.some(c => c.includes("tmux"))).toBe(false);
  });

  test("not inside a tmux pane → clean error", async () => {
    delete process.env.TMUX_PANE;
    const r = await headSpawn("kobo", emit);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not inside a tmux pane");
  });

  test("contract asset missing → clean error before any tmux call", async () => {
    rmSync(join(homeDir, ".claude", "skills", "head", "contracts", "reviewer.md"));
    const r = await headSpawn("kobo", emit);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("contract asset missing");
    expect(commands.some(c => c.includes("tmux"))).toBe(false);
  });

  test("happy path: 3-pane cell, both opus, no worker window ever created", async () => {
    paneListForSession = "%lead|||👤 lead|||main\n";
    bootTranscript["%p1"] = ["", "claude code — bypass permissions on"]; // conductor
    bootTranscript["%p2"] = ["", "claude code — bypass permissions on"]; // reviewer
    const r = await headSpawn("kobo", emit);
    expect(r.ok).toBe(true);

    const splitCalls = commands.filter(c => c.includes("tmux split-window"));
    expect(splitCalls.length).toBe(2); // conductor + reviewer, NO worker window
    expect(commands.some(c => c.includes("tmux new-window"))).toBe(false); // head ≠ crew
    expect(splitCalls[0]).toContain("--model opus");
    expect(splitCalls[1]).toContain("--model opus");
    // reviewer (not conductor) gets --settings (Stop hook → conductor)
    expect(splitCalls[0]).not.toContain("--settings");
    expect(splitCalls[1]).toContain("--settings");
    expect(splitCalls[1]).toContain("CREW_ROLE=reviewer");

    // lead pane tagged, never spawned via tmux new-window/split-window
    expect(commands.some(c => c.includes("set-option -p -t '%lead' @role") && c.includes("lead"))).toBe(true);
  });

  // kobo-364 empirical finding (live dogfood, throwaway session): a 3-way
  // horizontal split makes the reviewer pane genuinely narrow in a normal
  // terminal (~19 cols observed) — the CC TUI's "bypass permissions on"
  // footer doesn't fit and truncates, so a width-bound substring check
  // FALSE-NEGATIVEs a pane that actually booted fine (first dogfood run hit
  // this for real — reviewer reported boot-fail while visibly booted).
  // Regression-pins the width-independent "❯" prompt-marker fallback.
  test("narrow-pane boot (truncated status line, no 'bypass permissions' substring) still detects success via the ❯ prompt marker", async () => {
    paneListForSession = "%lead|||👤 lead|||main\n";
    bootTranscript["%p1"] = ["", "claude code — bypass permissions on"]; // conductor: normal-width boot
    // reviewer: narrow pane — truncated footer, NO "bypass permissions" substring,
    // but the boxed input prompt "❯" still renders on its own line (verified live).
    bootTranscript["%p2"] = ["", "───────────────\n❯ \n───────────────\n  ● online\n  ⏵⏵ bypass     ·"];
    const r = await headSpawn("kobo", emit);
    expect(r.ok).toBe(true);
  });

  test("conductor boot-fail → LOUD notify (resolved addr, not bare pane-id), reviewer never spawned, hard stop", async () => {
    paneListForSession = "%lead|||👤 lead|||main\n";
    bootTranscript["%p1"] = ["not available for your account"]; // conductor never boots
    const r = await headSpawn("kobo", emit);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("conductor failed to boot");

    const splitCalls = commands.filter(c => c.includes("tmux split-window"));
    expect(splitCalls.length).toBe(1); // reviewer never spawned — hard stop after conductor fails

    const heyCalls = commands.filter(c => c.startsWith("maw hey"));
    expect(heyCalls.length).toBe(1);
    expect(heyCalls[0]).toContain("sess:0.0"); // resolved session:window.pane, not bare %lead
    expect(heyCalls[0]).not.toContain("%lead ");
    expect(heyCalls[0]).toContain("conductor");
    expect(logs.some(l => l.includes("boot-fail"))).toBe(true);

    // NO fallback-to-cheaper-model: only ever tried opus, no retry with a different model
    expect(commands.filter(c => c.includes("tmux split-window") && c.includes("conductor")).length).toBeLessThanOrEqual(1);
    expect(commands.some(c => c.includes("--model sonnet"))).toBe(false);
  });

  test("reviewer boot-fail → conductor already up, LOUD notify, hard stop (no fallback model)", async () => {
    paneListForSession = "%lead|||👤 lead|||main\n";
    bootTranscript["%p1"] = ["", "claude code — bypass permissions on"]; // conductor boots fine
    bootTranscript["%p2"] = ["not available for your account"]; // reviewer never boots
    const r = await headSpawn("kobo", emit);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("reviewer failed to boot");

    const heyCalls = commands.filter(c => c.startsWith("maw hey"));
    expect(heyCalls.length).toBe(1);
    expect(heyCalls[0]).toContain("reviewer");
    expect(logs.some(l => l.includes("boot-fail"))).toBe(true);
    expect(commands.some(c => c.includes("--model sonnet"))).toBe(false); // no fallback tier
  });

  test("idempotency: teardownCrewWindows called with the lead pane as protectPaneId (never empty)", async () => {
    paneListForSession = "%lead|||👤 lead|||main\n%oldcond|||🎼 conductor|||main\n%oldrev|||🔎 reviewer|||main";
    bootTranscript["%p1"] = ["", "claude code — bypass permissions on"];
    bootTranscript["%p2"] = ["", "claude code — bypass permissions on"];
    await headSpawn("kobo", emit);
    // the pre-spawn teardown pass killed the leftover conductor/reviewer, never the lead
    expect(commands.some(c => c.includes("kill-pane -t '%oldcond'"))).toBe(true);
    expect(commands.some(c => c.includes("kill-pane -t '%oldrev'"))).toBe(true);
    expect(commands.some(c => c.includes("kill-pane -t '%lead'"))).toBe(false);
  });
});
