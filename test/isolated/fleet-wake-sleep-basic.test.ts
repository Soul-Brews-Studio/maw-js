/**
 * Focused isolated coverage for src/commands/shared/fleet-wake.ts happy paths.
 */
import { describe, expect, test } from "bun:test";
import { join } from "path";
import { addRepo, cmdSleep, cmdWakeAll, fleetDir, ghqRoot, state } from "../helpers/fleet-wake-harness";

describe("cmdSleep", () => {
  test("saves tab order and counts only sessions that were killed", async () => {
    state.fleet = [
      { name: "01-awake", windows: [{ name: "awake-oracle", repo: "awake" }] },
      { name: "02-missing", windows: [{ name: "missing-oracle", repo: "missing" }] },
    ];
    state.hasSessions = new Set(["01-awake"]);

    await cmdSleep();

    expect(state.captured).toEqual([
      "saveTabOrder 01-awake",
      "killSession 01-awake",
      "saveTabOrder 02-missing",
      "killSession 02-missing",
    ]);
  });
});

describe("cmdWakeAll", () => {
  test("wakes non-dormant sessions, skips dormant by default, restores order, and resumes on request", async () => {
    state.fleet = [
      { name: "01-alpha", windows: [{ name: "alpha-oracle", repo: "alpha" }, { name: "alpha-tools", repo: "alpha-tools" }] },
      { name: "20-dormant", windows: [{ name: "dormant-oracle", repo: "dormant" }] },
      { name: "99-system", windows: [{ name: "system-oracle", repo: "system" }], skip_command: true },
    ];
    addRepo("alpha");
    addRepo("alpha-tools");
    addRepo("system");
    state.retried = 1;
    state.extraWorktrees = 2;
    state.restoreCounts = new Map([["01-alpha", 1], ["99-system", 2]]);

    await cmdWakeAll({ resume: true });

    expect(state.respawnArgs[0].map(s => s.name)).toEqual(["01-alpha", "99-system"]);
    expect(state.resumeCalls).toBe(1);
    expect(state.captured).toContain(`newSession 01-alpha alpha-oracle ${join(ghqRoot, "alpha")}`);
    expect(state.captured).toContain(`newWindow 01-alpha:alpha-tools ${join(ghqRoot, "alpha-tools")}`);
    expect(state.captured).toContain("setEnvironment 01-alpha MAW_TEST_ENV=yes");
    expect(state.captured).toContain("sendText 01-alpha:alpha-oracle run alpha-oracle");
    expect(state.captured).toContain("sendText 01-alpha:alpha-tools run alpha-tools");
    expect(state.captured).toContain("ensureSessionRunning 01-alpha");
    expect(state.captured).not.toContain("ensureSessionRunning 99-system");
    expect(state.captured.some(c => c.includes("20-dormant"))).toBe(false);
    expect(state.captured).toContain("restoreTabOrder 01-alpha");
    expect(state.captured).toContain("restoreTabOrder 99-system");
    expect(state.captured).toContain("resumeActiveItems");
  });

  test("--all includes dormant sessions and existing sessions are left untouched", async () => {
    state.fleet = [{ name: "20-dormant", windows: [{ name: "dormant-oracle", repo: "dormant" }] }];
    state.hasSessions = new Set(["20-dormant"]);
    addRepo("dormant");

    await cmdWakeAll({ all: true });

    expect(state.captured).toContain("hasSession 20-dormant");
    expect(state.captured.some(c => c.startsWith("newSession 20-dormant"))).toBe(false);
    expect(state.captured).toContain("respawnMissingWorktrees 20-dormant");
  });

  test("--kill sleeps existing sessions before waking", async () => {
    state.fleet = [{ name: "01-alpha", windows: [{ name: "alpha-oracle", repo: "alpha" }] }];
    state.hasSessions = new Set(["01-alpha"]);
    addRepo("alpha");
    await cmdWakeAll({ kill: true });
    expect(state.captured.slice(0, 3)).toEqual(["saveTabOrder 01-alpha", "killSession 01-alpha", "hasSession 01-alpha"]);
    expect(state.captured).toContain(`newSession 01-alpha alpha-oracle ${join(ghqRoot, "alpha")}`);
  });
});
