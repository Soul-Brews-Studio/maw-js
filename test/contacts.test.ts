/**
 * Tests for `maw contacts add` — flag parsing + canonical schema fields.
 *
 * Background: the /contacts skill canonical schema (SKILL.md) specifies five
 * per-contact fields: `maw`, `thread`, `inbox`, `repo`, `notes`. The maw-js
 * CLI originally supported only three (`--maw`, `--thread`, `--notes`), so
 * contacts written by other oracles via /contacts came through canonical but
 * `maw contacts add` couldn't populate `inbox` or `repo`. This test locks the
 * fix: all five flags parse, persist, and round-trip through the JSON file.
 *
 * Following the bud-root.test.ts convention, we exercise cmdContactsAdd by
 * pointing cwd at a temp dir so the fs writes are isolated and deterministic.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { cmdContactsAdd } from "../src/commands/contacts";

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  prevCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "maw-contacts-test-"));
  // Pre-create ψ/ so resolvePsiPath() picks the canonical unicode branch
  // instead of falling through to the romanized "psi" fallback.
  mkdirSync(join(tmp, "ψ"), { recursive: true });
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
});

function readContacts(): any {
  const path = join(tmp, "ψ", "contacts.json");
  expect(existsSync(path)).toBe(true);
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("cmdContactsAdd — canonical schema flag parsing", () => {
  test("--maw / --thread / --notes still work (regression)", async () => {
    await cmdContactsAdd("alpha", ["--maw", "a:agent", "--thread", "ch:alpha", "--notes", "first"]);
    const data = readContacts();
    expect(data.contacts.alpha).toEqual({
      maw: "a:agent",
      thread: "ch:alpha",
      notes: "first",
    });
  });

  test("--inbox flag persists inbox field", async () => {
    await cmdContactsAdd("beta", ["--inbox", "https://ex.com/inbox"]);
    const data = readContacts();
    expect(data.contacts.beta.inbox).toBe("https://ex.com/inbox");
  });

  test("--repo flag persists repo field", async () => {
    await cmdContactsAdd("gamma", ["--repo", "laris-co/gamma-oracle"]);
    const data = readContacts();
    expect(data.contacts.gamma.repo).toBe("laris-co/gamma-oracle");
  });

  test("all five canonical flags together round-trip cleanly", async () => {
    await cmdContactsAdd("delta", [
      "--maw", "white:delta",
      "--thread", "channel:delta",
      "--inbox", "https://delta.example/inbox",
      "--repo", "Soul-Brews-Studio/delta-oracle",
      "--notes", "canonical five-field contact",
    ]);
    const data = readContacts();
    expect(data.contacts.delta).toEqual({
      maw: "white:delta",
      thread: "channel:delta",
      inbox: "https://delta.example/inbox",
      repo: "Soul-Brews-Studio/delta-oracle",
      notes: "canonical five-field contact",
    });
  });

  test("second add call merges new fields into existing contact (update semantics)", async () => {
    await cmdContactsAdd("epsilon", ["--maw", "e:agent", "--thread", "ch:e"]);
    await cmdContactsAdd("epsilon", ["--inbox", "https://e.inbox", "--repo", "o/e"]);
    const data = readContacts();
    expect(data.contacts.epsilon).toEqual({
      maw: "e:agent",
      thread: "ch:e",
      inbox: "https://e.inbox",
      repo: "o/e",
    });
  });

  test("contacts.json has canonical top-level shape (contacts + updated only)", async () => {
    await cmdContactsAdd("zeta", ["--maw", "z:agent"]);
    const data = readContacts();
    expect(Object.keys(data).sort()).toEqual(["contacts", "updated"]);
    expect(typeof data.updated).toBe("string");
  });
});
