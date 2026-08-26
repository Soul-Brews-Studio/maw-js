import { describe, test, expect } from "bun:test";
import { windowMatchesWorktreeSuffix } from "../src/vendor/mpr-plugins/done/done-worktree";

// Regression for `maw done` leaving the worktree behind on --work/--wt workers.
// The window is "<oracle>-<wtName>"; the worktree dir is "<N>-<wtName>". The old
// matcher stripped only the first hyphen-segment of the window name, so a
// hyphenated oracle name ("pilot-hello-disposable") never matched its worktree.
describe("windowMatchesWorktreeSuffix", () => {
  test("hyphenated oracle name matches its numbered worktree (the reported bug)", () => {
    // window pilot-hello-disposable-wt-repro1  ↔  worktree 1-wt-repro1
    expect(windowMatchesWorktreeSuffix("pilot-hello-disposable-wt-repro1", "1-wt-repro1")).toBe(true);
    expect(windowMatchesWorktreeSuffix("pilot-hello-disposable-wt-smoke1", "1-wt-smoke1")).toBe(true);
  });

  test("simple single-segment oracle name still matches", () => {
    expect(windowMatchesWorktreeSuffix("nntn-wt-x", "3-wt-x")).toBe(true);
  });

  test("exact worktree name (no oracle prefix) matches", () => {
    expect(windowMatchesWorktreeSuffix("wt-x", "1-wt-x")).toBe(true);
    expect(windowMatchesWorktreeSuffix("wt-x", "wt-x")).toBe(true);
  });

  test("case-insensitive", () => {
    expect(windowMatchesWorktreeSuffix("Pilot-Hello-WT-Repro1", "1-wt-repro1")).toBe(true);
  });

  test("suffix must be a hyphen-bounded tail — no substring false-match", () => {
    // "wt-repro1" must NOT match the longer worktree "wt-repro11"
    expect(windowMatchesWorktreeSuffix("pilot-hello-disposable-wt-repro1", "1-wt-repro11")).toBe(false);
    // window tail that merely contains the slug mid-word does not match
    expect(windowMatchesWorktreeSuffix("pilot-xwt-repro1", "1-wt-repro1")).toBe(false);
  });

  test("different worktree slug does not match", () => {
    expect(windowMatchesWorktreeSuffix("pilot-hello-disposable-wt-other", "1-wt-repro1")).toBe(false);
  });

  test("empty worktree slug never matches", () => {
    expect(windowMatchesWorktreeSuffix("anything", "1-")).toBe(false);
  });
});
