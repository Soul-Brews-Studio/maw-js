import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { cmdTeamRemove, removeMemberFromCharterText } from "../../src/vendor/mpr-plugins/team/team-remove";

const cwdRoot = mkdtempSync(join(tmpdir(), "maw-team-remove-"));
const root = () => cwdRoot;
const charterPath = () => join(root(), ".maw", "teams", "alpha.yaml");

const CHARTER = [
  "name: alpha",
  "session: lead-session",
  "members:",
  "  - role: lead",
  "    name: mawjs-oracle",
  "    engine: codex",
  "  - role: worker",
  "    name: mawjs-worker",
  "    engine: omx",
  "",
].join("\n");

function writeCharter(text = CHARTER) {
  mkdirSync(join(root(), ".maw", "teams"), { recursive: true });
  writeFileSync(charterPath(), text, "utf-8");
}

function fakeTmux(lines: string[]) {
  return {
    run: async (...args: string[]) => {
      if (args[0] === "list-panes") return lines.join("\n");
      if (args[0] === "display-message") return "lead-session\n";
      return "";
    },
  };
}

describe("removeMemberFromCharterText", () => {
  test("drops the matched member block, keeps the rest + trailing newline", () => {
    const out = removeMemberFromCharterText(CHARTER, "worker");
    expect(out).toContain("role: lead");
    expect(out).not.toContain("role: worker");
    expect(out).not.toContain("mawjs-worker");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.startsWith("name: alpha")).toBe(true);
  });

  test("matches by name as well as role", () => {
    const out = removeMemberFromCharterText(CHARTER, "mawjs-worker");
    expect(out).not.toContain("role: worker");
    expect(out).toContain("role: lead");
  });

  test("throws when the member is absent", () => {
    expect(() => removeMemberFromCharterText(CHARTER, "ghost")).toThrow("member not found in charter: ghost");
  });

  test("refuses to remove the last remaining member", () => {
    const solo = ["name: alpha", "members:", "  - role: lead", "    name: only", ""].join("\n");
    expect(() => removeMemberFromCharterText(solo, "lead")).toThrow("refusing to remove the last member");
  });
});

describe("cmdTeamRemove", () => {
  beforeEach(() => {
    rmSync(cwdRoot, { recursive: true, force: true });
    writeCharter();
  });
  afterEach(() => {
    rmSync(cwdRoot, { recursive: true, force: true });
  });

  test("tears down the worktree then edits the charter atomically", async () => {
    const doneCalls: Array<{ windowName: string; opts: Record<string, unknown> }> = [];
    const result = await cmdTeamRemove("alpha", "worker", {}, {
      tmux: fakeTmux([
        "lead-session|mawjs-oracle|claude|/wt|%1",
        "lead-session|mawjs-worker|omx|/wt|%2",
      ]),
      cwd: root(),
      loadConfigFn: () => ({}) as any,
      cmdDoneFn: async (windowName, opts = {}) => {
        doneCalls.push({ windowName, opts: opts as Record<string, unknown> });
      },
      logger: () => {},
    });

    expect(doneCalls).toEqual([{ windowName: "mawjs-worker", opts: { sessionName: "lead-session", keepBranch: undefined } }]);
    expect(result.member).toBe("worker");
    expect(result.actions.map((a) => a.phase)).toEqual(["teardown", "charter"]);

    const after = readFileSync(charterPath(), "utf-8");
    expect(after).not.toContain("role: worker");
    expect(after).toContain("role: lead");
    expect(after.endsWith("\n")).toBe(true);
  });

  test("--keep-branch is forwarded to done", async () => {
    const doneCalls: Array<Record<string, unknown>> = [];
    await cmdTeamRemove("alpha", "worker", { keepBranch: true }, {
      tmux: fakeTmux(["lead-session|mawjs-worker|omx|/wt|%2"]),
      cwd: root(),
      loadConfigFn: () => ({}) as any,
      cmdDoneFn: async (_w, opts = {}) => { doneCalls.push(opts as Record<string, unknown>); },
      logger: () => {},
    });
    expect(doneCalls[0]).toEqual({ sessionName: "lead-session", keepBranch: true });
  });

  test("--dry-run touches nothing", async () => {
    let doneCalled = false;
    const before = readFileSync(charterPath(), "utf-8");
    const result = await cmdTeamRemove("alpha", "worker", { dryRun: true }, {
      tmux: fakeTmux(["lead-session|mawjs-worker|omx|/wt|%2"]),
      cwd: root(),
      loadConfigFn: () => ({}) as any,
      cmdDoneFn: async () => { doneCalled = true; },
      logger: () => {},
    });
    expect(doneCalled).toBe(false);
    expect(readFileSync(charterPath(), "utf-8")).toBe(before);
    expect(result.output).toContain("No changes made");
  });

  test("worktree: false members skip teardown but still edit charter", async () => {
    writeCharter([
      "name: alpha",
      "session: lead-session",
      "members:",
      "  - role: lead",
      "    name: mawjs-oracle",
      "  - role: peer",
      "    name: oss-oracle",
      "    worktree: false",
      "",
    ].join("\n"));
    let doneCalled = false;
    const result = await cmdTeamRemove("alpha", "peer", {}, {
      tmux: fakeTmux([]),
      cwd: root(),
      loadConfigFn: () => ({}) as any,
      cmdDoneFn: async () => { doneCalled = true; },
      logger: () => {},
    });
    expect(doneCalled).toBe(false);
    expect(result.actions[0]!.detail).toContain("no worktree");
    expect(readFileSync(charterPath(), "utf-8")).not.toContain("role: peer");
  });

  test("rejects an unknown member", async () => {
    await expect(cmdTeamRemove("alpha", "ghost", {}, {
      tmux: fakeTmux([]),
      cwd: root(),
      loadConfigFn: () => ({}) as any,
      logger: () => {},
    })).rejects.toThrow("member not found: ghost");
  });
});
