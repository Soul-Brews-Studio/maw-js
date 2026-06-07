import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import handler, { command } from "../../src/vendor/mpr-plugins/profile";
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

describe("vendor profile plugin index coverage", () => {
  const originalMawHome = process.env.MAW_HOME;
  const originalConfigDir = process.env.MAW_CONFIG_DIR;
  let dir: string;
  let configDir: string;
  let profilesDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "maw-profile-plugin-"));
    configDir = join(dir, "config");
    profilesDir = join(configDir, "profiles");
    delete process.env.MAW_HOME;
    process.env.MAW_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (originalMawHome === undefined) delete process.env.MAW_HOME;
    else process.env.MAW_HOME = originalMawHome;

    if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
    else process.env.MAW_CONFIG_DIR = originalConfigDir;

    rmSync(dir, { recursive: true, force: true });
  });

  const writeProfile = (name: string, body: Record<string, unknown>) => {
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(join(profilesDir, `${name}.json`), JSON.stringify(body, null, 2), "utf-8");
  };

  test("exports metadata and prints help for missing CLI or non-CLI subcommands", async () => {
    expect(command).toEqual({
      name: "profile",
      description: "Profile primitive — named plugin bundles (Phase 1 of #640 / #888).",
    });

    const missing = await handler(cli([]));
    expect(missing.ok).toBe(true);
    expect(missing.output).toContain("usage: maw profile <list|use|show|current>");
    expect(missing.output).toContain("<CONFIG_DIR>/profiles/<name>.json");

    const nonCli = await handler(api({ subcommand: "list" }));
    expect(nonCli.ok).toBe(true);
    expect(nonCli.output).toContain("usage: maw profile <list|use|show|current>");
  });

  test("list/ls seed the all profile, mark the active profile, and support writer streaming", async () => {
    writeProfile("lean", { name: "lean", plugins: ["scope", "trust"], tiers: ["core"], description: "lean set" });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "profile-active"), "lean\n", "utf-8");

    const listed = await handler(cli(["list"]));
    expect(listed.ok).toBe(true);
    expect(listed.output).toContain("name");
    expect(listed.output).toContain("lean");
    expect(listed.output).toContain("*  lean");
    expect(listed.output).toContain("all");
    expect(existsSync(join(profilesDir, "all.json"))).toBe(true);

    const writerLines: string[] = [];
    const streamed = await handler(cli(["ls"], (...args) => writerLines.push(args.map(String).join(" "))));
    expect(streamed).toEqual({ ok: true, output: "" });
    expect(writerLines.join("\n")).toContain("lean");
  });

  test("use/set validates usage, refuses unknown profiles, and writes active pointer", async () => {
    writeProfile("minimal", { name: "minimal", plugins: ["scope"], description: "small" });

    expect(await handler(cli(["use"]))).toEqual({ ok: false, error: "usage: maw profile use <name>" });

    const missing = await handler(cli(["set", "missing"]));
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('profile "missing" not found');

    const used = await handler(cli(["use", "minimal", "--ignored"]));
    expect(used.ok).toBe(true);
    expect(used.output).toContain('active profile: "minimal"');
    expect(readFileSync(join(configDir, "profile-active"), "utf-8")).toBe("minimal\n");
  });

  test("show/info/current aliases and error paths are reported without throwing", async () => {
    writeProfile("ops", { plugins: ["wake"], description: "no name field is normalized" });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "profile-active"), "ops\n", "utf-8");

    expect(await handler(cli(["show"]))).toEqual({ ok: false, error: "usage: maw profile show <name>" });

    const shown = await handler(cli(["info", "ops"]));
    expect(shown.ok).toBe(true);
    expect(JSON.parse(shown.output!)).toMatchObject({ name: "ops", plugins: ["wake"] });

    const missing = await handler(cli(["show", "nope"]));
    expect(missing).toEqual({ ok: false, error: 'profile "nope" not found', output: "" });

    expect(await handler(cli(["active"]))).toEqual({ ok: true, output: "ops" });
  });

  test("unknown subcommands include help and writer failures restore console", async () => {
    const unknown = await handler(cli(["wat"]));
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toBe('maw profile: unknown subcommand "wat" (expected list|use|show|current)');
    expect(unknown.output).toContain("usage: maw profile <list|use|show|current>");

    const originalLog = console.log;
    const exploded = await handler(cli([], () => {
      throw new Error("profile writer exploded");
    }));

    expect(exploded).toEqual({ ok: false, error: "profile writer exploded", output: undefined });
    expect(console.log).toBe(originalLog);
  });
});
