import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { scopePath, scopesDir } from "../src/lib/scope-paths";
import {
  cmdAdd,
  loadTrust,
  samePair,
  saveTrust,
  trustPath,
} from "../src/lib/trust-store";

const originalMawHome = process.env.MAW_HOME;
const originalMawConfigDir = process.env.MAW_CONFIG_DIR;
const originalMawStateDir = process.env.MAW_STATE_DIR;

let tempRoot = "";

function resetEnv() {
  if (originalMawHome === undefined) delete process.env.MAW_HOME;
  else process.env.MAW_HOME = originalMawHome;
  if (originalMawConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
  else process.env.MAW_CONFIG_DIR = originalMawConfigDir;
  if (originalMawStateDir === undefined) delete process.env.MAW_STATE_DIR;
  else process.env.MAW_STATE_DIR = originalMawStateDir;
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "maw-lib-coverage-"));
  delete process.env.MAW_HOME;
  delete process.env.MAW_CONFIG_DIR;
  delete process.env.MAW_STATE_DIR;
});

afterEach(() => {
  resetEnv();
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

describe("scope path helpers", () => {
  test("MAW_HOME wins and appends config/scopes", () => {
    process.env.MAW_HOME = join(tempRoot, "maw-home");
    process.env.MAW_CONFIG_DIR = join(tempRoot, "ignored-config");

    expect(scopesDir()).toBe(join(tempRoot, "maw-home", "config", "scopes"));
    expect(scopePath("dev")).toBe(join(tempRoot, "maw-home", "config", "scopes", "dev.json"));
  });

  test("MAW_CONFIG_DIR is used when MAW_HOME is absent", () => {
    process.env.MAW_CONFIG_DIR = join(tempRoot, "config-dir");

    expect(scopesDir()).toBe(join(tempRoot, "config-dir", "scopes"));
    expect(scopePath("team.alpha")).toBe(join(tempRoot, "config-dir", "scopes", "team.alpha.json"));
  });
});

describe("trust store helpers", () => {
  test("trustPath follows MAW_HOME/MAW_STATE_DIR precedence", () => {
    process.env.MAW_HOME = join(tempRoot, "home-root");
    process.env.MAW_STATE_DIR = join(tempRoot, "ignored-state");
    process.env.MAW_CONFIG_DIR = join(tempRoot, "ignored");
    expect(trustPath()).toBe(join(tempRoot, "home-root", "trust.json"));

    delete process.env.MAW_HOME;
    process.env.MAW_STATE_DIR = join(tempRoot, "state-root");
    process.env.MAW_CONFIG_DIR = join(tempRoot, "config-root");
    expect(trustPath()).toBe(join(tempRoot, "state-root", "trust.json"));
  });

  test("loadTrust is forgiving for missing files, wrong shape, and corrupt JSON", () => {
    process.env.MAW_CONFIG_DIR = join(tempRoot, "config");
    process.env.MAW_STATE_DIR = join(tempRoot, "state");
    mkdirSync(process.env.MAW_STATE_DIR, { recursive: true });
    const path = trustPath();

    expect(loadTrust()).toEqual([]);

    writeFileSync(path, JSON.stringify({ sender: "a" }));
    expect(loadTrust()).toEqual([]);

    writeFileSync(path, "not-json");
    expect(loadTrust()).toEqual([]);
  });

  test("loadTrust returns [] when the trust path exists but cannot be read as a file", () => {
    process.env.MAW_CONFIG_DIR = join(tempRoot, "config");
    process.env.MAW_STATE_DIR = join(tempRoot, "state");
    mkdirSync(trustPath(), { recursive: true });

    expect(loadTrust()).toEqual([]);
  });

  test("loadTrust filters invalid entries and keeps valid entries", () => {
    process.env.MAW_CONFIG_DIR = join(tempRoot, "config");
    process.env.MAW_STATE_DIR = join(tempRoot, "state");
    mkdirSync(process.env.MAW_STATE_DIR, { recursive: true });
    const path = trustPath();

    writeFileSync(path, JSON.stringify([
      { sender: "a", target: "b", addedAt: "2026-01-01T00:00:00.000Z" },
      { sender: "missing-target", addedAt: "2026-01-01T00:00:00.000Z" },
      null,
      { sender: "c", target: "d", addedAt: 123 },
    ]));

    expect(loadTrust()).toEqual([
      { sender: "a", target: "b", addedAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  test("loadTrust reads legacy config trust and cmdAdd migrates forward to state", () => {
    process.env.MAW_STATE_DIR = join(tempRoot, "state");
    process.env.MAW_CONFIG_DIR = join(tempRoot, "config");
    const legacyPath = join(process.env.MAW_CONFIG_DIR, "trust.json");
    const legacyEntry = { sender: "legacy-a", target: "legacy-b", addedAt: "2026-01-01T00:00:00.000Z" };
    mkdirSync(process.env.MAW_CONFIG_DIR, { recursive: true });
    writeFileSync(legacyPath, JSON.stringify([legacyEntry], null, 2));

    expect(loadTrust()).toEqual([legacyEntry]);

    const added = cmdAdd("fresh-a", "fresh-b");
    expect(added.added).toBe(true);
    expect(loadTrust()).toEqual([legacyEntry, added.entry]);
    expect(JSON.parse(readFileSync(trustPath(), "utf-8"))).toEqual([legacyEntry, added.entry]);
    expect(JSON.parse(readFileSync(legacyPath, "utf-8"))).toEqual([legacyEntry]);
  });

  test("saveTrust writes atomically shaped JSON and samePair is symmetric", () => {
    process.env.MAW_CONFIG_DIR = join(tempRoot, "config");
    process.env.MAW_STATE_DIR = join(tempRoot, "state");

    expect(samePair({ sender: "a", target: "b" }, { sender: "a", target: "b" })).toBe(true);
    expect(samePair({ sender: "a", target: "b" }, { sender: "b", target: "a" })).toBe(true);
    expect(samePair({ sender: "a", target: "c" }, { sender: "b", target: "a" })).toBe(false);

    saveTrust([{ sender: "a", target: "b", addedAt: "now" }]);
    expect(readFileSync(trustPath(), "utf-8")).toBe(
      '[\n  {\n    "sender": "a",\n    "target": "b",\n    "addedAt": "now"\n  }\n]\n',
    );
    expect(loadTrust()).toEqual([{ sender: "a", target: "b", addedAt: "now" }]);
  });

  test("cmdAdd validates input, adds once, and treats reversed pairs as existing", () => {
    process.env.MAW_CONFIG_DIR = join(tempRoot, "config");
    process.env.MAW_STATE_DIR = join(tempRoot, "state");

    expect(() => cmdAdd("", "b")).toThrow("sender must be a non-empty string");
    expect(() => cmdAdd("a", "")).toThrow("target must be a non-empty string");
    expect(() => cmdAdd("a", "a")).toThrow("refusing self-trust pair");

    const first = cmdAdd("a", "b");
    expect(first.added).toBe(true);
    expect(first.entry.sender).toBe("a");
    expect(first.entry.target).toBe("b");
    expect(Date.parse(first.entry.addedAt)).not.toBeNaN();

    const second = cmdAdd("b", "a");
    expect(second).toEqual({ added: false, entry: first.entry });
    expect(loadTrust()).toEqual([first.entry]);
  });
});
