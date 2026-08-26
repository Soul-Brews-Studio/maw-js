/**
 * done-work-worktree-slot.test.ts — regression for `maw done` leaving a --work
 * worker's worktree slot behind.
 *
 * Root cause: the fleet record stores win.repo = the BASE repo (org/repo) for a
 * --work worker, losing the worktree-slot association. removeWorktreeViaConfig
 * then resolves win.repo → the main repo (not a worktree) and returns without
 * removing the slot; with several work windows on one base repo the ghq scan
 * cannot disambiguate which slot belongs to which window.
 *
 * Fix: an additive win.worktree field (slot path rel reposRoot) written at
 * --work registration; removeWorktreeViaConfig prefers it. Legacy records
 * without the field fall back to the ghq scan (matcher fixed in #3).
 *
 * These drive the REAL cmdDone path (real done-worktree), mocking only the sdk
 * transport + fleet config dir + auto-save/charter side effects.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as realSdk from "../../src/sdk";  // pre-captured so the mock preserves every real export

const GHQ = "/repos";                       // ghqRoot
const REPOS_ROOT = `${GHQ}/github.com`;     // where org/repo lives

let fleetDir = "";
let sessions: Array<{ name: string; windows: { index: number; name: string; active: boolean }[] }> = [];
let execCommands: string[] = [];
let worktreesOnDisk = new Set<string>();    // absolute slot paths the scan `find` should surface

function writeFleet(file: string, obj: unknown) {
  writeFileSync(join(fleetDir, file), JSON.stringify(obj, null, 2) + "\n");
}

// --- mocks: keep done-worktree REAL; stub only the sdk transport it touches ----
mock.module("maw-js/sdk", () => ({
  ...realSdk,
  listSessions: async () => sessions,
  takeSnapshot: async () => "/tmp/snap.json",
  loadFleetEntries: () => [],
  tmux: {
    ...realSdk.tmux,
    run: async () => "no-tmux\t0\n",     // identity read; not lead → guard passes
    killWindow: async (t: string) => { execCommands.push(`kill ${t}`); },
    sendText: async () => undefined,
  },
  hostExec: async (command: string) => {
    execCommands.push(command);
    if (command.startsWith("find ")) {
      return [...worktreesOnDisk].join("\n");
    }
    if (command.includes("rev-parse --abbrev-ref")) return "agents/1-x\n";
    // git worktree remove / prune / rev-parse etc → succeed silently
    return "";
  },
}));
mock.module("maw-js/config/ghq-root", () => ({ getGhqRoot: () => GHQ }));
mock.module("maw-js/core/matcher/normalize-target", () => ({ normalizeTarget: (t: string) => t }));
mock.module(join(import.meta.dir, "../../src/vendor/mpr-plugins/done/done-autosave"), () => ({
  signalParentInbox: () => {},
  autoSave: async () => {},
}));
mock.module("maw-js/vendor/mpr-plugins/team/team-charter", () => ({ readTeamCharter: () => null }));
mock.module("maw-js/vendor/mpr-plugins/team/team-liveness", () => ({ findRepoRoot: () => "/none", resolveCharterPath: () => null }));

const { cmdDone } = await import("../../src/vendor/mpr-plugins/done/impl");

let mawHome = "";
const origMawHome = process.env.MAW_HOME;
afterAll(() => {
  mock.restore();
  if (origMawHome === undefined) delete process.env.MAW_HOME; else process.env.MAW_HOME = origMawHome;
  if (mawHome) rmSync(mawHome, { recursive: true, force: true });
});

beforeEach(() => {
  // MAW_HOME redirects fleetDirsForRead/ForWrite → MAW_HOME/fleet (no ~/.maw pollution).
  mawHome = mkdtempSync(join(tmpdir(), "done-wt-slot-"));
  process.env.MAW_HOME = mawHome;
  fleetDir = join(mawHome, "fleet");
  mkdirSync(fleetDir, { recursive: true });
  execCommands = [];
  worktreesOnDisk = new Set();
  sessions = [];
});

function removedSlot(): string | undefined {
  const cmd = execCommands.find(c => c.includes("worktree remove"));
  const m = cmd?.match(/worktree remove '([^']+)'/);
  return m?.[1];
}

describe("maw done removes the --work worker's own worktree slot", () => {
  test("uses the recorded win.worktree slot (not the base repo)", async () => {
    sessions = [{ name: "04-croo", windows: [
      { index: 0, name: "croo", active: true },
      { index: 1, name: "pilot-pl-disposable-wt-hello", active: false },
    ] }];
    writeFleet("04-croo.json", { name: "04-croo", windows: [
      { name: "croo", repo: "TTT3P/croo-oracle" },
      // --work worker: repo = BASE repo, worktree = the slot (the fix)
      { name: "pilot-pl-disposable-wt-hello", repo: "org/pilot-pl-disposable", worktree: "org/pilot-pl-disposable/agents/1-wt-hello" },
    ] });

    await cmdDone("pilot-pl-disposable-wt-hello", { force: true, cwd: `${REPOS_ROOT}/org/pilot-pl-disposable` });

    expect(removedSlot()).toBe(`${REPOS_ROOT}/org/pilot-pl-disposable/agents/1-wt-hello`);
  });

  test("two work windows on one base repo → done removes only its OWN slot", async () => {
    sessions = [{ name: "04-croo", windows: [
      { index: 0, name: "croo", active: true },
      { index: 1, name: "pilot-pl-disposable-wt-alpha", active: false },
      { index: 2, name: "pilot-pl-disposable-wt-beta", active: false },
    ] }];
    writeFleet("04-croo.json", { name: "04-croo", windows: [
      { name: "croo", repo: "TTT3P/croo-oracle" },
      { name: "pilot-pl-disposable-wt-alpha", repo: "org/pilot-pl-disposable", worktree: "org/pilot-pl-disposable/agents/1-wt-alpha" },
      { name: "pilot-pl-disposable-wt-beta", repo: "org/pilot-pl-disposable", worktree: "org/pilot-pl-disposable/agents/2-wt-beta" },
    ] });

    await cmdDone("pilot-pl-disposable-wt-beta", { force: true, cwd: `${REPOS_ROOT}/org/pilot-pl-disposable` });

    // only the beta slot removed — the shared base repo disambiguates by win.worktree
    expect(removedSlot()).toBe(`${REPOS_ROOT}/org/pilot-pl-disposable/agents/2-wt-beta`);
    expect(execCommands.join("\n")).not.toContain("agents/1-wt-alpha");
    expect(execCommands.join("\n")).not.toContain("worktree remove '/repos/github.com/org/pilot-pl-disposable'");
  });

  test("legacy window without win.worktree → ghq scan resolves the slot (matcher #3)", async () => {
    sessions = [{ name: "04-croo", windows: [
      { index: 0, name: "croo", active: true },
      { index: 1, name: "pilot-pl-disposable-wt-legacy", active: false },
    ] }];
    // legacy record: repo = base repo, NO worktree field
    writeFleet("04-croo.json", { name: "04-croo", windows: [
      { name: "croo", repo: "TTT3P/croo-oracle" },
      { name: "pilot-pl-disposable-wt-legacy", repo: "org/pilot-pl-disposable" },
    ] });
    // the scan's `find` surfaces the real slot on disk
    worktreesOnDisk.add(`${REPOS_ROOT}/org/pilot-pl-disposable/agents/1-wt-legacy`);

    await cmdDone("pilot-pl-disposable-wt-legacy", { force: true, cwd: `${REPOS_ROOT}/org/pilot-pl-disposable` });

    // hyphenated repo-stem prefix stripped by windowMatchesWorktreeSuffix → slot removed
    expect(removedSlot()).toBe(`${REPOS_ROOT}/org/pilot-pl-disposable/agents/1-wt-legacy`);
  });
});
