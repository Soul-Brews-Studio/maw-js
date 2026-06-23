import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

let fleetReadDirs: string[] = [];
let hostExecCalls: string[] = [];
let hostExecHandler: (command: string) => string | Promise<string> = () => "";
const tmpRoots: string[] = [];

mock.module("maw-js/sdk", () => ({
  hostExec: async (command: string) => {
    hostExecCalls.push(command);
    return await hostExecHandler(command);
  },
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  fleetDirsForRead: () => fleetReadDirs,
}));

const { inferRetrospectiveCommand } = await import(
  "../../src/vendor/mpr-plugins/done/retrospective-command.ts?plugin-done-standalone"
);
const { removeWorktreeViaConfig } = await import(
  "../../src/vendor/mpr-plugins/done/done-worktree.ts?plugin-done-standalone"
);

afterEach(() => {
  fleetReadDirs = [];
  hostExecCalls = [];
  hostExecHandler = () => "";
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("done command plugin standalone boundary", () => {
  test("touched done autosave files keep explicit standalone import boundaries", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "done",
      // index.ts added (#PR24): it now fires an on-signal worklog PR poll, so its
      // single deep import (maw-js/core/worklog/pr-watch) is pinned explicitly.
      files: ["index.ts", "impl.ts", "done-autosave.ts", "done-worktree.ts", "retrospective-command.ts"],
      allowRelative: ["./done-autosave", "./done-worktree", "../../../core/xdg"],
      allowMawJs: [
        /^maw-js\/core\/matcher\/normalize-target$/,
        /^maw-js\/core\/fleet\/worktree-layout$/,
        /^maw-js\/core\/worklog\/pr-watch$/,
        /^maw-js\/commands\/shared\/fleet-load$/,
        /^maw-js\/commands\/shared\/wake-resolve$/,
        /^maw-js\/config\/ghq-root$/,
        /^maw-js\/vendor\/mpr-plugins\/team\/team-charter$/,
        /^maw-js\/vendor\/mpr-plugins\/team\/team-liveness$/,
      ],
    }).map((record) => record.spec);

    expect(imports).toContain("maw-js/sdk");
    expect(imports).toContain("./retrospective-command");
    expect(imports).toContain("maw-js/core/worklog/pr-watch");
  });

  test("shared retrospective inference covers claude, omx, and codex-style engines", () => {
    expect(inferRetrospectiveCommand("claude")).toBe("/rrr");
    expect(inferRetrospectiveCommand("node")).toBe("/rrr");
    expect(inferRetrospectiveCommand("omx")).toBe("$rrr");
    expect(inferRetrospectiveCommand("oh-my-codex")).toBe("$rrr");
    expect(inferRetrospectiveCommand("codex")).toBeNull();
    expect(inferRetrospectiveCommand("aider")).toBeNull();
    expect(inferRetrospectiveCommand("opencode")).toBeNull();
  });

  test("done worktree cleanup refuses dirty removals unless force is explicit", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-plugin-done-boundary-"));
    tmpRoots.push(root);
    const fleetDir = join(root, "fleet");
    mkdirSync(fleetDir, { recursive: true });
    writeFileSync(join(fleetDir, "team.json"), JSON.stringify({
      windows: [{ name: "codex-1", repo: "Soul-Brews-Studio/maw-js.wt-codex-1" }],
    }));
    fleetReadDirs = [fleetDir];

    const reposRoot = join(root, "github.com");
    const worktreePath = join(reposRoot, "Soul-Brews-Studio", "maw-js.wt-codex-1");
    hostExecHandler = (command) => {
      if (command.includes("rev-parse --abbrev-ref HEAD")) return "feature/done\n";
      if (command.includes("worktree remove") && !command.includes("--force")) {
        throw new Error("fatal: contains modified or untracked files");
      }
      return "";
    };

    await expect(removeWorktreeViaConfig("codex-1", reposRoot)).rejects.toThrow(
      "has uncommitted changes; rerun maw done --force",
    );

    expect(hostExecCalls).toContain(`git -C '${worktreePath}' rev-parse --abbrev-ref HEAD`);
    expect(hostExecCalls.some(command => command.includes("worktree remove") && command.includes("--force"))).toBe(false);

    hostExecCalls = [];
    await expect(removeWorktreeViaConfig("codex-1", reposRoot, { force: true })).resolves.toBe(true);
    expect(hostExecCalls.some(command => command.includes("worktree remove") && command.includes("--force"))).toBe(true);
  });
});
