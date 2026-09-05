import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";

import {
  parseRelayCloseArgs,
  relayCaptureArgs,
  runRelayClose,
  type RelayCloseDeps,
  type RelayCloseState,
} from "../../src/commands/plugins/relay-close/impl";
import {
  buildRelayWorkerArgs,
  currentMawCommand,
  waitForWorkerBootstrap,
} from "../../src/commands/plugins/relay-close/runtime";

const RETRO = "/repo/reports/retrospectives/2026-08-17_close.md";
const HANDOFF = "/repo/ψ/inbox/handoff/2026-08-17_close.md";

function scriptedDeps(captures: string[]) {
  const sent: string[] = [];
  const states: RelayCloseState[] = [];
  let now = 1_000;
  let index = 0;
  const deps: RelayCloseDeps = {
    capture: async () => captures[Math.min(index++, captures.length - 1)] ?? "",
    submitCommand: async (_target, text) => { sent.push(text); },
    sleep: async () => { now += 10; },
    now: () => now,
    realpath: (path) => path,
    stat: (path) => ({ isFile: true, mtimeMs: path === RETRO ? 10 : 20 }),
    readFile: () => "verified artifact\n",
    recordState: (state) => { states.push({ ...state }); },
  };
  return { deps, sent, states };
}

describe("relay-close deterministic lifecycle", () => {
  test("requires both the retrospective and handoff paths", () => {
    expect(() => parseRelayCloseArgs(["04-croo:croo-oracle.1", "--handoff", HANDOFF]))
      .toThrow("--retrospective");
    expect(() => parseRelayCloseArgs(["04-croo:croo-oracle.1", "--retrospective", RETRO]))
      .toThrow("--handoff");
  });

  test("defaults to the current exact tmux pane and rejects ambiguous targets", () => {
    expect(parseRelayCloseArgs([
      "--retrospective", RETRO,
      "--handoff", HANDOFF,
    ], { TMUX_PANE: "%42" }).target).toBe("%42");
    expect(() => parseRelayCloseArgs([
      "local:croo",
      "--retrospective", RETRO,
      "--handoff", HANDOFF,
    ], {})).toThrow("exact pane target");
  });

  test("joins tmux soft-wrapped lines before matching the exact handoff ack", () => {
    expect(relayCaptureArgs("%42")).toEqual(["capture-pane", "-t", "%42", "-e", "-J", "-p"]);
  });

  test("the detached worker keeps both artifacts and the exact target", () => {
    expect(buildRelayWorkerArgs({
      target: "04-croo:croo-oracle.1",
      retrospectivePath: RETRO,
      handoffPath: HANDOFF,
      timeoutMs: 90_000,
    }, "job-1")).toEqual([
      "relay-close",
      "04-croo:croo-oracle.1",
      "--retrospective", RETRO,
      "--handoff", HANDOFF,
      "--timeout", "90",
      "--run",
      "--job-id", "job-1",
    ]);
  });

  test("respawns through either the source launcher or compiled maw binary", () => {
    const existingEntry = (path: string) => path === "/repo/src/cli.ts" || path === "/repo/dist/maw";
    expect(currentMawCommand(["bun", "/repo/src/cli.ts", "relay-close"], "/bun", existingEntry))
      .toEqual({ command: "/bun", argsPrefix: ["/repo/src/cli.ts"] });
    expect(currentMawCommand(["bun", "/repo/dist/maw", "relay-close"], "/bun", existingEntry))
      .toEqual({ command: "/bun", argsPrefix: ["/repo/dist/maw"] });
    expect(currentMawCommand(["bun", "/$bunfs/root/maw", "relay-close"], "/repo/maw-compiled", existingEntry))
      .toEqual({ command: "/repo/maw-compiled", argsPrefix: [] });
    expect(currentMawCommand(["/repo/maw-standalone", "relay-close", "%42"], "/repo/maw-standalone", existingEntry))
      .toEqual({ command: "/repo/maw-standalone", argsPrefix: [] });
  });

  test("detects a detached worker that exits during bootstrap", async () => {
    const child = new EventEmitter() as unknown as Parameters<typeof waitForWorkerBootstrap>[0];
    const outcome = waitForWorkerBootstrap(child, 1_000);
    queueMicrotask(() => child.emit("exit", 1, null));
    await expect(outcome).resolves.toEqual({ kind: "exit", code: 1, signal: null });
  });

  test("rejects a handoff older than the retrospective", async () => {
    const { deps } = scriptedDeps([]);
    deps.stat = (path) => ({ isFile: true, mtimeMs: path === RETRO ? 30 : 20 });

    await expect(runRelayClose({
      target: "04-croo:croo-oracle.1",
      retrospectivePath: RETRO,
      handoffPath: HANDOFF,
      timeoutMs: 100,
      pollMs: 10,
    }, deps)).rejects.toThrow("handoff must be written after the retrospective");
  });

  test("rejects artifact paths that could inject another pane command", async () => {
    const { deps } = scriptedDeps([]);
    deps.realpath = (path) => path;
    await expect(runRelayClose({
      target: "04-croo:croo-oracle.1",
      retrospectivePath: RETRO,
      handoffPath: `${HANDOFF}\n/clear`,
    }, deps)).rejects.toThrow("whitespace or control");
  });

  test("sends clear then recap with the exact handoff and requires read proof", async () => {
    const idleBefore = "closing session\n────────────────\n❯";
    const idleAfterClear = "Claude Code\n────────────────\n❯";
    const recapDone = `Handoff read: ${HANDOFF}\nCarry-over: publish complete\n────────────────\n❯`;
    const { deps, sent, states } = scriptedDeps([
      "✻ Undulating… (esc to interrupt)\n❯",
      idleBefore,
      idleBefore,
      "clearing context",
      idleAfterClear,
      idleAfterClear,
      "✻ Working (1s · esc to interrupt)\n❯",
      recapDone,
      recapDone,
    ]);

    const result = await runRelayClose({
      target: "04-croo:croo-oracle.1",
      retrospectivePath: RETRO,
      handoffPath: HANDOFF,
      timeoutMs: 500,
      pollMs: 10,
    }, deps);

    expect(sent).toEqual(["/clear", `/recap ${HANDOFF}`]);
    expect(result.status).toBe("complete");
    expect(result.handoffPath).toBe(HANDOFF);
    expect(states.map((state) => state.status)).toEqual([
      "validating",
      "waiting-idle",
      "clearing",
      "recapping",
      "complete",
    ]);
  });

  test("does not recap until clear reaches a fresh Claude Code prompt", async () => {
    const oldPrompt = "closing session\n❯";
    const changedButNotCleared = "footer clock changed\n❯";
    const { deps, sent, states } = scriptedDeps([
      oldPrompt,
      oldPrompt,
      changedButNotCleared,
      changedButNotCleared,
      changedButNotCleared,
    ]);

    await expect(runRelayClose({
      target: "04-croo:croo-oracle.1",
      retrospectivePath: RETRO,
      handoffPath: HANDOFF,
      timeoutMs: 35,
      pollMs: 10,
    }, deps)).rejects.toThrow("clear did not reach a fresh Claude Code prompt");

    expect(sent).toEqual(["/clear"]);
    expect(states.at(-1)?.status).toBe("failed");
  });

  test("does not accept a stale Claude banner while old context remains", async () => {
    const oldPrompt = "Claude Code\nold decision still visible\n❯";
    const swallowedClear = "Claude Code\nold decision still visible\nclock 15:31\n❯";
    const { deps, sent } = scriptedDeps([
      oldPrompt, oldPrompt,
      swallowedClear, swallowedClear, swallowedClear, swallowedClear,
    ]);

    await expect(runRelayClose({
      target: "04-croo:croo-oracle.1",
      retrospectivePath: RETRO,
      handoffPath: HANDOFF,
      timeoutMs: 35,
      pollMs: 10,
    }, deps)).rejects.toThrow("clear did not reach a fresh Claude Code prompt");
    expect(sent).toEqual(["/clear"]);
  });

  test("never reports complete when recap does not acknowledge the handoff", async () => {
    const idleBefore = "closing session\n❯";
    const idleAfterClear = "Claude Code\n❯";
    const wrongRecap = "Recap complete from model memory\n❯";
    const { deps, sent, states } = scriptedDeps([
      idleBefore,
      idleBefore,
      "clearing context",
      idleAfterClear,
      idleAfterClear,
      wrongRecap,
      wrongRecap,
      wrongRecap,
    ]);

    await expect(runRelayClose({
      target: "04-croo:croo-oracle.1",
      retrospectivePath: RETRO,
      handoffPath: HANDOFF,
      timeoutMs: 35,
      pollMs: 10,
    }, deps)).rejects.toThrow("recap did not acknowledge the handoff");

    expect(sent).toEqual(["/clear", `/recap ${HANDOFF}`]);
    expect(states.at(-1)?.status).toBe("failed");
  });
});
