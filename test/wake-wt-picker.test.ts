/**
 * Regression tests for #1768 — `--wt <host>` picker on ambiguous worktrees.
 *
 * Before this fix, `maw wake <oracle> --wt white` threw an "ambiguous"
 * error when multiple existing `<N>-white` worktrees matched the bare
 * host name, forcing the user to retype an exact `--task <N>-white`.
 *
 * `maw a` already shows a numbered picker for the same shape of ambiguity
 * (#1781), so wake now matches that UX. Non-TTY callers still get the loud
 * error (scripted callers must fail fast).
 */
import { afterEach, describe, test, expect } from "bun:test";
import { promptAmbiguousWorktreePick, _wtPicker } from "../src/commands/shared/wake-cmd";

const candidates = [
  { name: "1-white", path: "/repos/homelab.wt-1-white" },
  { name: "2-white", path: "/repos/homelab.wt-2-white" },
];

const originalIsStdoutTTY = _wtPicker.isStdoutTTY;
const originalReadChoice = _wtPicker.readChoice;

afterEach(() => {
  _wtPicker.isStdoutTTY = originalIsStdoutTTY;
  _wtPicker.readChoice = originalReadChoice;
});

describe("promptAmbiguousWorktreePick (#1768) — numbered picker on ambiguous wt", () => {
  test("returns the picked candidate when stdin reads a valid choice", () => {
    _wtPicker.isStdoutTTY = () => true;
    _wtPicker.readChoice = () => "2";
    expect(promptAmbiguousWorktreePick("white", candidates)).toEqual(candidates[1]!);
  });

  test("returns null on non-TTY so caller falls back to loud error", () => {
    _wtPicker.isStdoutTTY = () => false;
    _wtPicker.readChoice = () => "1";
    expect(promptAmbiguousWorktreePick("white", candidates)).toBeNull();
  });

  test("returns null when read fails (e.g. /dev/tty unavailable)", () => {
    _wtPicker.isStdoutTTY = () => true;
    _wtPicker.readChoice = () => null;
    expect(promptAmbiguousWorktreePick("white", candidates)).toBeNull();
  });

  test("returns null when choice is out of range", () => {
    _wtPicker.isStdoutTTY = () => true;
    _wtPicker.readChoice = () => "9";
    expect(promptAmbiguousWorktreePick("white", candidates)).toBeNull();
  });

  test("returns null when choice is non-numeric", () => {
    _wtPicker.isStdoutTTY = () => true;
    _wtPicker.readChoice = () => "abc";
    expect(promptAmbiguousWorktreePick("white", candidates)).toBeNull();
  });

  test("returns null when choice only starts numeric", () => {
    _wtPicker.isStdoutTTY = () => true;
    _wtPicker.readChoice = () => "1abc";
    expect(promptAmbiguousWorktreePick("white", candidates)).toBeNull();
  });

  test("returns null on empty/whitespace input", () => {
    _wtPicker.isStdoutTTY = () => true;
    _wtPicker.readChoice = () => "";
    expect(promptAmbiguousWorktreePick("white", candidates)).toBeNull();
  });

  test("first choice resolves to first candidate (1-indexed sanity)", () => {
    _wtPicker.isStdoutTTY = () => true;
    _wtPicker.readChoice = () => "1";
    expect(promptAmbiguousWorktreePick("white", candidates)).toEqual(candidates[0]!);
  });
});
