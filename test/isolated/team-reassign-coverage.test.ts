import { beforeEach, describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { cmdTeamReassign } from "../../src/vendor/mpr-plugins/team/team-reassign";

const cwdRoot = mkdtempSync(join(tmpdir(), "maw-team-reassign-"));
const root = () => cwdRoot;
const teamDir = () => join(root(), ".maw", "teams");

function writeTeam() {
  mkdirSync(teamDir(), { recursive: true });
  writeFileSync(
    join(teamDir(), "alpha.yaml"),
    [
      "name: alpha",
      "session: lead-session",
      "members:",
      "  - role: lead",
      "    name: mawjs-oracle",
      "    engine: codex",
      "  - role: worker",
      "    name: mawjs-worker",
      "    engine: omx",
    ].join("\n") + "\n",
    "utf-8",
  );
}

function fakeTmux(lines: string[]) {
  const calls: string[][] = [];
  const tmux = {
    run: async (...args: string[]) => {
      calls.push(args.map(String));
      if (args[0] === "list-panes") return lines.join("\n");
      if (args[0] === "display-message") return "lead-session\n";
      return "";
    },
  };
  return { tmux, calls };
}

describe("team-reassign helper", () => {
  beforeEach(() => {
    rmSync(cwdRoot, { recursive: true, force: true });
    writeTeam();
  });

  afterEach(() => {
    rmSync(cwdRoot, { recursive: true, force: true });
  });

  test("done then fresh wake in one command", async () => {
    const doneCalls: Array<{ windowName: string; opts: Record<string, unknown> }> = [];
    const wakeCalls: Array<[string, Record<string, unknown>]> = [];
    const promptCalls: number[] = [];
    const { tmux, calls } = fakeTmux([
      "lead-session|mawjs-oracle|claude|/wt|%1",
      "lead-session|mawjs-worker|omx|/wt|%2",
    ]);

    const result = await cmdTeamReassign("alpha", "worker", 123, {}, {
      tmux,
      cwd: root(),
      cmdDoneFn: async (windowName: string, opts = {}) => {
        doneCalls.push({ windowName, opts: opts as Record<string, unknown> });
      },
      cmdWakeFn: async (oracle: string, wakeOpts: Record<string, unknown>) => {
        wakeCalls.push([oracle, wakeOpts]);
      },
      fetchIssuePromptFn: async (num: number) => {
        promptCalls.push(num);
        return `prompt:${num}`;
      },
      logger: () => {},
    });

    expect(result.actions).toEqual([
      { phase: "done", window: "mawjs-worker" },
      { phase: "wake", window: "mawjs-worker", issue: 123 },
    ]);
    expect(doneCalls).toEqual([{ windowName: "mawjs-worker", opts: { sessionName: "lead-session" } }]);
    expect(wakeCalls).toEqual([[
      "mawjs-worker",
      {
        task: "issue-123",
        prompt: "prompt:123",
        fresh: true,
        session: "lead-session",
        wt: "mawjs-worker",
        engine: "omx",
        repoPath: root(),
      },
    ]]);
    expect(promptCalls).toEqual([123]);
    expect(calls).toContainEqual(["list-panes", "-a", "-F", "#{session_name}|#{window_name}|#{pane_current_command}|#{pane_current_path}|#{pane_id}|#{pane_pid}|#{session_id}|#{window_id}"]);
  });

  test("rejects unresolved members", async () => {
    await expect(cmdTeamReassign("alpha", "missing", 123, {}, { tmux: fakeTmux([]).tmux, cwd: root(), logger: () => {} }))
      .rejects.toThrow("member not found: missing");
  });
});
