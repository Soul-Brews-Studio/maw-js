/**
 * Regression test for #1151 — `maw wake --help` should NOT create a session.
 *
 * Background: parseFlags drops unrecognized flags (like --help) into the
 * positional `_` array. Without a guard, `--help` reaches cmdWake as the
 * oracle name and gets sanitized into a session named `26---help`.
 */
import { describe, test, expect } from "bun:test";
import { cmdWake } from "../src/commands/shared/wake-cmd";
import { UserError } from "../src/core/util/user-error";

describe("cmdWake — flag-shaped name guard (#1151)", () => {
  test("rejects --help", async () => {
    await expect(cmdWake("--help", {})).rejects.toThrow(UserError);
  });

  test("rejects --dry-run", async () => {
    await expect(cmdWake("--dry-run", {})).rejects.toThrow(UserError);
  });

  test("rejects short flag -e", async () => {
    await expect(cmdWake("-e", {})).rejects.toThrow(UserError);
  });

  test("error message suggests 'maw --help'", async () => {
    await expect(cmdWake("--help", {})).rejects.toThrow(/maw --help/);
  });
});
