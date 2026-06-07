import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

let sessions: Array<{ name: string }> = [];

mock.module("maw-js/sdk", () => ({
  tmux: {
    listSessions: async () => sessions,
    listPaneIds: async () => new Set<string>(),
    killPane: async () => undefined,
  },
  hostExec: async () => "",
}));

const helpers = await import("../../src/vendor/mpr-plugins/team/team-helpers.ts");
const lifecycle = await import("../../src/vendor/mpr-plugins/team/team-lifecycle.ts?team-prune-empty");

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "maw-team-prune-"));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

afterEach(() => {
  sessions = [];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("maw team prune (#2419)", () => {
  test("deletes empty inactive tool teams and keeps active or memberful teams", async () => {
    const root = tempRoot();
    const teamsDir = join(root, "teams");
    helpers._setDirs(teamsDir, join(root, "tasks"));

    writeJson(join(teamsDir, "empty/config.json"), { name: "empty", members: [] });
    writeJson(join(teamsDir, "active/config.json"), { name: "active", members: [] });
    writeJson(join(teamsDir, "prefixed/config.json"), { name: "prefixed", members: [] });
    writeJson(join(teamsDir, "busy/config.json"), { name: "busy", members: [{ name: "builder" }] });
    mkdirSync(join(teamsDir, "broken"), { recursive: true });
    writeFileSync(join(teamsDir, "broken", "config.json"), "{ nope");

    sessions = [{ name: "active" }, { name: "09-prefixed" }];

    const pruned = await lifecycle.cmdTeamPrune();

    expect(pruned).toEqual(["empty"]);
    expect(existsSync(join(teamsDir, "empty"))).toBe(false);
    expect(existsSync(join(teamsDir, "active"))).toBe(true);
    expect(existsSync(join(teamsDir, "prefixed"))).toBe(true);
    expect(existsSync(join(teamsDir, "busy"))).toBe(true);
    expect(existsSync(join(teamsDir, "broken"))).toBe(true);
  });
});
