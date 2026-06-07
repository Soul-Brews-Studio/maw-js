import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realChildProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tempRoot = mkdtempSync(join(tmpdir(), "maw-bud-fleet-"));
const configDir = join(tempRoot, "config");
const stateDir = join(tempRoot, "state");
process.env.MAW_CONFIG_DIR = configDir;
process.env.MAW_STATE_DIR = stateDir;
process.env.MAW_TEST_MODE = "1";
mkdirSync(join(configDir, "fleet"), { recursive: true });

let remotes = new Map<string, string>();
let throwRemote = false;
let execCalls: Array<{ cmd: string; args: string[] }> = [];

mock.module("child_process", () => ({
  ...realChildProcess,
  execFileSync: (cmd: string, args: string[], _opts: unknown) => {
    execCalls.push({ cmd, args });
    if (throwRemote) throw new Error("not a git repo");
    const target = args[1];
    const remote = remotes.get(target);
    if (!remote) throw new Error("missing remote");
    return `${remote}\n`;
  },
}));

const mod = await import("../../src/vendor/mpr-plugins/bud/from-repo-fleet.ts?bud-from-repo-fleet-coverage");
const { parseRemoteUrl, readOriginRemote, resolveSlug, registerFleetEntry } = mod;
const { FLEET_DIR } = await import("maw-js/core/paths");
const { fleetDirForWrite } = await import("maw-js/commands/shared/fleet-load");
const WRITE_FLEET_DIR = fleetDirForWrite();

function resetFleet() {
  rmSync(FLEET_DIR, { recursive: true, force: true });
  rmSync(WRITE_FLEET_DIR, { recursive: true, force: true });
  mkdirSync(FLEET_DIR, { recursive: true });
  remotes = new Map();
  throwRemote = false;
  execCalls = [];
}

function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf-8"));
}

beforeEach(() => {
  resetFleet();
});

describe("bud from-repo fleet coverage", () => {
  test("parses recognized remote URL shapes and rejects unrecognized input", () => {
    expect(parseRemoteUrl("git@github.com:Soul-Brews-Studio/maw-js.git")).toEqual({
      org: "Soul-Brews-Studio",
      repo: "maw-js",
    });
    expect(parseRemoteUrl("https://github.com/Soul-Brews-Studio/maw-js")).toEqual({
      org: "Soul-Brews-Studio",
      repo: "maw-js",
    });
    expect(parseRemoteUrl("  ssh://git@host.example/org/repo-name.git  ")).toEqual({
      org: "org",
      repo: "repo-name",
    });
    expect(parseRemoteUrl("not a url")).toBeNull();
  });

  test("reads origin remote with argv-safe git call and resolves fallback slugs", () => {
    const target = join(tempRoot, "repo-one");
    remotes.set(target, "https://github.com/acme/repo-one.git");

    expect(readOriginRemote(target)).toBe("https://github.com/acme/repo-one.git");
    expect(resolveSlug(target)).toEqual({ org: "acme", repo: "repo-one" });
    expect(execCalls[0]).toEqual({
      cmd: "git",
      args: ["-C", target, "remote", "get-url", "origin"],
    });

    throwRemote = true;
    const fallbackTarget = join(tempRoot, "fallback-repo");
    expect(readOriginRemote(fallbackTarget)).toBeNull();
    expect(resolveSlug(fallbackTarget)).toEqual({ org: "<unknown>", repo: "fallback-repo" });
  });

  test("creates next numbered fleet entry with slug and optional lineage", () => {
    writeFileSync(join(FLEET_DIR, "01-existing.json"), "{}\n");
    writeFileSync(join(FLEET_DIR, "09-old.disabled"), "{}\n");
    writeFileSync(join(FLEET_DIR, "12-ignored.txt"), "{}\n");
    writeFileSync(join(FLEET_DIR, "07-other.json"), "{}\n");
    const target = join(tempRoot, "child");
    remotes.set(target, "git@github.com:org/child.git");

    const result = registerFleetEntry({ stem: "child", target, parent: "parent" });

    expect(result.created).toBe(true);
    expect(result.slug).toEqual({ org: "org", repo: "child" });
    expect(result.file).toBe(join(WRITE_FLEET_DIR, "08-child.json"));
    const cfg = readJson(result.file);
    expect(cfg.name).toBe("08-child");
    expect(cfg.windows).toEqual([{ name: "child-oracle", repo: "org/child" }]);
    expect(cfg.sync_peers).toEqual([]);
    expect(cfg.budded_from).toBe("parent");
    expect(typeof cfg.budded_at).toBe("string");
  });

  test("is idempotent for existing entries and merges missing lineage only once", () => {
    const existing = join(FLEET_DIR, "03-sprout.json");
    writeFileSync(existing, JSON.stringify({ name: "03-sprout", windows: [] }, null, 2) + "\n");
    const target = join(tempRoot, "sprout");
    remotes.set(target, "https://github.com/org/sprout.git");

    const first = registerFleetEntry({ stem: "sprout", target, parent: "root" });
    expect(first).toEqual({ file: existing, created: false, slug: { org: "org", repo: "sprout" } });
    const withLineage = readJson(existing);
    expect(withLineage.budded_from).toBe("root");
    expect(typeof withLineage.budded_at).toBe("string");

    const stamp = withLineage.budded_at;
    const second = registerFleetEntry({ stem: "sprout", target, parent: "other" });
    expect(second.created).toBe(false);
    expect(readJson(existing).budded_at).toBe(stamp);
    expect(readJson(existing).budded_from).toBe("root");
  });

  test("uses 01 and creates the write fleet directory when no entries exist", () => {
    rmSync(FLEET_DIR, { recursive: true, force: true });
    rmSync(WRITE_FLEET_DIR, { recursive: true, force: true });
    const target = join(tempRoot, "first");
    throwRemote = true;

    const result = registerFleetEntry({ stem: "first", target });

    expect(result.file).toBe(join(WRITE_FLEET_DIR, "01-first.json"));
    expect(existsSync(FLEET_DIR)).toBe(false);
    expect(readJson(result.file).name).toBe("01-first");
  });
});
