/**
 * Fleet-child recovery — IN-PROCESS COMPONENT test (#dept-roster D-5).
 *
 * This imports `cmdWake` directly and mocks the fleet loader + tmux transport,
 * so per runtime-change-loop.md rule 3 it is component-level evidence, NOT a
 * same-interface proof: it exercises the recovery decision and command
 * construction in-process, but does not cross the real CLI/launcher boundary.
 * The external-boundary companion is fleet-child-recovery-cli-boundary.test.ts.
 *
 *   POS  cmdWake("cookbook")     (runtime+launch) → resumes, injecting a command
 *                                that carries launch.env + launch.cwd.
 *   NEG  cmdWake("cookbook-dev") (no runtime)     → falls through to the normal
 *                                wake flow, never throwing a recovery error.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const CAPTURED_AT = "2026-08-19T21:10:00.000Z";

let fleetSessions: any[] = [];
const sentText: { target: string; text: string }[] = [];
const newSessions: { name: string; opts: any }[] = [];

function resetCaptures() {
  sentText.length = 0;
  newSessions.length = 0;
}

// Delegate to the real modules and override only the boundaries we control, so
// unrelated exports of these facades keep resolving for transitive importers.
const _realSdk = await import("../../src/sdk");
const _realFleetLoad = await import("../../src/commands/shared/fleet-load");
const _realWakeTarget = await import("../../src/commands/shared/wake-target");

// --- mock the tmux transport (the external boundary) ---
mock.module(join(import.meta.dir, "../../src/sdk"), () => ({
  ..._realSdk,
  tmux: {
    ..._realSdk.tmux,
    hasSession: async () => false,
    listWindows: async () => [],
    newSession: async (name: string, opts: any) => { newSessions.push({ name, opts }); return name; },
    newWindow: async () => {},
    sendText: async (target: string, text: string) => { sentText.push({ target, text }); },
    selectWindow: async () => {},
  },
}));

// --- mock the fleet loader (the persistence boundary) ---
mock.module(join(import.meta.dir, "../../src/commands/shared/fleet-load"), () => ({
  ..._realFleetLoad,
  loadFleet: () => fleetSessions,
}));

// --- NEG proof: make the first normal-wake step observable with a sentinel ---
const SENTINEL = "SENTINEL_reached_normal_wake";
mock.module(join(import.meta.dir, "../../src/commands/shared/wake-target"), () => ({
  ..._realWakeTarget,
  parseWakeTarget: () => { throw new Error(SENTINEL); },
}));

const { cmdWake } = await import("../../src/commands/shared/wake-cmd");

beforeEach(resetCaptures);

describe("maw wake <bare-name> — fleet-child recovery (POS)", () => {
  test("cookbook (runtime+launch) resumes with launch.env exported and launch.cwd overriding captured cwd", async () => {
    fleetSessions = [{
      name: "25-cookbook",
      windows: [{
        name: "cookbook",
        repo: "org/nntn-cookbook",
        runtime: {
          engine: "codex",
          cwd: "/Users/x/tt3p/product-hub/nntn-cookbook",
          nativeSessionId: "sess-abc",
          capturedAt: CAPTURED_AT,
          launch: {
            cwd: "/Users/x/tt3p/ratified-root",
            env: { CODEX_HOME: "/Users/x/.codex-cookbook" },
            argv: ["codex", "resume"],
          },
        },
      }],
    }];

    const target = await cmdWake("cookbook", {});
    expect(target).toBe("25-cookbook:cookbook");

    // the session was created at the captured cwd
    expect(newSessions).toHaveLength(1);
    expect(newSessions[0]!.opts.cwd).toBe("/Users/x/tt3p/product-hub/nntn-cookbook");

    // the injected command carries env + ratified workRoot + resume
    expect(sentText).toHaveLength(1);
    const cmd = sentText[0]!.text;
    expect(cmd).toContain("cd '/Users/x/tt3p/ratified-root'");
    expect(cmd).toContain("CODEX_HOME='/Users/x/.codex-cookbook'");
    expect(cmd).toContain("codex resume 'sess-abc'");
  });
});

describe("maw wake <bare-name> — fallthrough (NEG, regression guard)", () => {
  test("cookbook-dev (no runtime) falls through to normal wake, never a recovery error", async () => {
    fleetSessions = [{
      name: "05-nntn",
      windows: [{ name: "cookbook-dev" }], // no repo, no runtime — Riddler's class-3-no-repo row
    }];

    // Falling through reaches the normal wake flow, whose first step throws our
    // sentinel. A recovery "refusing"/"ambiguous" error would fail this instead.
    await expect(cmdWake("cookbook-dev", {})).rejects.toThrow(SENTINEL);
    // no resume command was injected
    expect(sentText).toHaveLength(0);
  });

  test("partial runtime ({engine} only) also falls through, not a throw", async () => {
    fleetSessions = [{
      name: "14-wallent",
      windows: [{ name: "finance-oracle", repo: "org/finance", runtime: { engine: "codex" } }],
    }];

    await expect(cmdWake("finance-oracle", {})).rejects.toThrow(SENTINEL);
    expect(sentText).toHaveLength(0);
  });

  test("a well-formed record for an unsupported engine falls through WITHOUT creating any tmux session/window (no abandoned pane)", async () => {
    // Hostile probe: 'gemini' passes shape validation but cannot be resumed.
    fleetSessions = [{
      name: "99-probe",
      windows: [{
        name: "gemini-seat",
        repo: "org/probe",
        runtime: {
          engine: "gemini",
          cwd: "/Users/x/tt3p/probe",
          nativeSessionId: "sess-xyz",
          capturedAt: CAPTURED_AT,
        },
      }],
    }];

    await expect(cmdWake("gemini-seat", {})).rejects.toThrow(SENTINEL);
    // the critical assertion: recovery bailed BEFORE any tmux mutation
    expect(newSessions).toHaveLength(0);
    expect(sentText).toHaveLength(0);
  });
});
