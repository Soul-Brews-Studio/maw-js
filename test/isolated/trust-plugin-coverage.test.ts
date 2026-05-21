import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import handler, { command } from "../../src/vendor/mpr-plugins/trust";
import type { InvokeContext } from "../../src/plugin/types";

const cli = (args: string[], writer?: (...args: unknown[]) => void): InvokeContext => ({
  source: "cli",
  args,
  writer,
});

const api = (args: Record<string, unknown> = {}): InvokeContext => ({
  source: "api",
  args,
});

describe("vendor trust plugin index coverage", () => {
  const originalMawHome = process.env.MAW_HOME;
  const originalConfigDir = process.env.MAW_CONFIG_DIR;
  const originalStateDir = process.env.MAW_STATE_DIR;
  let dir: string;
  let configDir: string;
  let stateDir: string;
  let trustFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "maw-trust-plugin-"));
    configDir = join(dir, "config");
    stateDir = join(dir, "state");
    trustFile = join(stateDir, "trust.json");
    delete process.env.MAW_HOME;
    process.env.MAW_CONFIG_DIR = configDir;
    process.env.MAW_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalMawHome === undefined) delete process.env.MAW_HOME;
    else process.env.MAW_HOME = originalMawHome;

    if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
    else process.env.MAW_CONFIG_DIR = originalConfigDir;

    if (originalStateDir === undefined) delete process.env.MAW_STATE_DIR;
    else process.env.MAW_STATE_DIR = originalStateDir;

    rmSync(dir, { recursive: true, force: true });
  });

  test("exports command metadata and prints help when no CLI subcommand is provided", async () => {
    expect(command).toEqual({
      name: "trust",
      description: "Pairwise trust list — list, add, remove (#842 Sub-B).",
    });

    const result = await handler(cli([]));

    expect(result.ok).toBe(true);
    expect(result.output).toContain("usage: maw trust <list|add|remove> [...]");
    expect(result.output).toContain("storage: <STATE_DIR>/trust.json");
    expect(existsSync(trustFile)).toBe(false);
  });

  test("non-CLI invocations ignore provided args and return help", async () => {
    const result = await handler(api({ subcommand: "list" }));

    expect(result.ok).toBe(true);
    expect(result.output).toContain("usage: maw trust <list|add|remove> [...]");
  });

  test("list and ls report an empty trust list through captured logs and writer", async () => {
    const captured = await handler(cli(["list"]));
    expect(captured).toEqual({ ok: true, output: "no trust entries" });

    const writerLines: string[] = [];
    const streamed = await handler(cli(["ls"], (...args) => writerLines.push(args.map(String).join(" "))));
    expect(streamed).toEqual({ ok: true, output: "" });
    expect(writerLines).toEqual(["no trust entries"]);
  });

  test("add validates usage, writes a new trust pair, and reports symmetric duplicates", async () => {
    const missing = await handler(cli(["add", "alpha"]));
    expect(missing).toEqual({ ok: false, error: "usage: maw trust add <sender> <target>" });

    const added = await handler(cli(["add", "alpha", "beta", "--ignored-flag"]));
    expect(added.ok).toBe(true);
    expect(added.output).toContain('trusted "alpha" ↔ "beta"');
    expect(added.output).toContain("added at ");

    const disk = JSON.parse(readFileSync(trustFile, "utf-8"));
    expect(disk).toHaveLength(1);
    expect(disk[0]).toMatchObject({ sender: "alpha", target: "beta" });
    expect(typeof disk[0].addedAt).toBe("string");

    const duplicate = await handler(cli(["add", "beta", "alpha"]));
    expect(duplicate.ok).toBe(true);
    expect(duplicate.output).toContain('already trusted: "alpha" ↔ "beta"');
    expect(JSON.parse(readFileSync(trustFile, "utf-8"))).toHaveLength(1);
  });

  test("add surfaces implementation validation errors with captured output", async () => {
    const selfTrust = await handler(cli(["add", "alpha", "alpha"]));

    expect(selfTrust.ok).toBe(false);
    expect(selfTrust.error).toContain('trust add: refusing self-trust pair "alpha↔alpha"');
    expect(selfTrust.output).toBe("");
  });

  test("remove validates usage, requires confirmation, supports aliases, and surfaces misses", async () => {
    await handler(cli(["add", "alpha", "beta"]));

    const missing = await handler(cli(["remove", "alpha"]));
    expect(missing).toEqual({
      ok: false,
      error: "usage: maw trust remove <sender> <target> [--yes]",
    });

    const unconfirmed = await handler(cli(["remove", "alpha", "beta"]));
    expect(unconfirmed.ok).toBe(false);
    expect(unconfirmed.error).toBe("remove requires --yes");
    expect(unconfirmed.output).toContain('refusing to remove trust pair "alpha ↔ beta" without --yes');
    expect(unconfirmed.output).toContain("to confirm: maw trust remove alpha beta --yes");

    const removed = await handler(cli(["rm", "beta", "alpha", "-y"]));
    expect(removed).toEqual({ ok: true, output: 'removed trust pair "alpha" ↔ "beta"' });
    expect(JSON.parse(readFileSync(trustFile, "utf-8"))).toEqual([]);

    await handler(cli(["add", "gamma", "delta"]));
    const deleted = await handler(cli(["delete", "gamma", "delta", "--yes"]));
    expect(deleted).toEqual({ ok: true, output: 'removed trust pair "gamma" ↔ "delta"' });

    const miss = await handler(cli(["remove", "missing", "pair", "--yes"]));
    expect(miss.ok).toBe(false);
    expect(miss.error).toBe('trust remove: no entry found for "missing↔pair"');
    expect(miss.output).toBe("");
  });

  test("unknown subcommands return help plus a clear error", async () => {
    const result = await handler(cli(["wat"]));

    expect(result.ok).toBe(false);
    expect(result.error).toBe('maw trust: unknown subcommand "wat" (expected list|add|remove)');
    expect(result.output).toContain("usage: maw trust <list|add|remove> [...]");
  });

  test("outer catch restores console and reports writer failures", async () => {
    const originalLog = console.log;
    const result = await handler(cli([], () => {
      throw new Error("writer exploded");
    }));

    expect(result).toEqual({ ok: false, error: "writer exploded", output: undefined });
    expect(console.log).toBe(originalLog);
  });
});
