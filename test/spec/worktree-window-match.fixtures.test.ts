import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveWorktreeWindow, type WorktreeWindowResolution } from "../../src/core/fleet/worktree-window-match";
import type { Session } from "../../src/core/runtime/find-window";

type Fixture = {
  name: string;
  input: {
    mainRepoName: string;
    wtName: string;
    sessions: Session[];
  };
  expected: WorktreeWindowResolution;
};

const fixtureUrl = new URL("./worktree-window-match.fixtures.json", import.meta.url);
const fixtures = JSON.parse(readFileSync(fixtureUrl, "utf8")) as Fixture[];

describe("portable worktree window match fixtures (#1612)", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      expect(resolveWorktreeWindow(
        fixture.input.mainRepoName,
        fixture.input.wtName,
        fixture.input.sessions,
      )).toEqual(fixture.expected);
    });
  }
});
