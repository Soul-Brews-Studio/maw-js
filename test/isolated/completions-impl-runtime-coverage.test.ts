/** Targeted runtime coverage for src/vendor/mpr-plugins/completions/impl.ts. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let discoveredPackages: any[] | Error = [];
let fleetSessions: any[] | Error = [];
let logs: string[] = [];
let errors: string[] = [];

const originalLog = console.log;
const originalError = console.error;

mock.module("maw-js/plugin/registry", () => ({
  discoverPackages: () => {
    if (discoveredPackages instanceof Error) throw discoveredPackages;
    return discoveredPackages;
  },
}));
mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleet: () => {
    if (fleetSessions instanceof Error) throw fleetSessions;
    return fleetSessions;
  },
}));

const { cmdCompletions } = await import("../../src/vendor/mpr-plugins/completions/impl.ts?completions-runtime-coverage");

function stdout(): string {
  return logs.join("\n");
}

beforeEach(() => {
  discoveredPackages = [];
  fleetSessions = [];
  logs = [];
  errors = [];
  console.log = (line?: unknown) => { logs.push(String(line ?? "")); };
  console.error = (line?: unknown) => { errors.push(String(line ?? "")); };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

describe("completions impl runtime coverage", () => {
  test("commands include core aliases and enabled plugin CLI names while excluding disabled or incomplete plugins", async () => {
    discoveredPackages = [
      { disabled: false, manifest: { name: "cli-plugin", cli: { command: "spark", aliases: ["sp"] } } },
      { disabled: false, kind: "ts", entryPath: "/plugins/source/index.ts", manifest: { name: "source-plugin" } },
      { disabled: false, kind: "wasm", wasmPath: "/plugins/wasm/wasm-plugin.wasm", manifest: { name: "wasm-plugin" } },
      { disabled: true, manifest: { name: "disabled-plugin", cli: { command: "hidden" } } },
      { disabled: false, kind: "ts", entryPath: undefined, manifest: { name: "no-entry" } },
    ];

    await cmdCompletions("commands");

    const commands = stdout().split(/\s+/).filter(Boolean);
    expect(commands).toContain("hey");
    expect(commands).toContain("wake");
    expect(commands).toContain("spark");
    expect(commands).toContain("sp");
    expect(commands).toContain("source-plugin");
    expect(commands).toContain("wasm-plugin");
    expect(commands).not.toContain("hidden");
    expect(commands).not.toContain("no-entry");
    expect(commands).toEqual([...commands].sort());
  });

  test("commands fall back to a safe minimal command set when plugin discovery fails", async () => {
    discoveredPackages = new Error("registry unavailable");

    await cmdCompletions("commands");

    const commands = stdout().split(/\s+/).filter(Boolean);
    expect(commands).toContain("fleet");
    expect(commands).toContain("team");
    expect(commands).toContain("wake");
    expect(commands).toContain("serve");
  });

  test("oracles and windows are derived from the shared XDG-aware fleet loader", async () => {
    fleetSessions = [
      {
        windows: [
          { name: "neo-oracle" },
          { name: "mawjs" },
          { name: "arra-oracle" },
        ],
      },
    ];

    await cmdCompletions("oracles");
    const oracles = stdout();
    logs = [];
    await cmdCompletions("windows");

    expect(oracles.split("\n")).toEqual(["arra", "neo"]);
    expect(stdout().split("\n")).toEqual(["arra-oracle", "mawjs", "neo-oracle"]);
  });

  test("shell and static subcommands emit installable completion payloads", async () => {
    await cmdCompletions("zsh");
    expect(stdout()).toContain("#compdef maw");
    expect(stdout()).toContain("maw completions oracles");

    logs = [];
    await cmdCompletions("bash");
    expect(stdout()).toContain("complete -F _maw_complete maw");
    expect(stdout()).toContain("maw completions commands");

    logs = [];
    await cmdCompletions("fish");
    expect(stdout()).toContain("complete -c maw");
    expect(stdout()).toContain("__fish_seen_subcommand_from wake about info");

    logs = [];
    await cmdCompletions("fleet");
    expect(stdout()).toBe("init ls renumber validate sync");

    logs = [];
    await cmdCompletions("pulse");
    expect(stdout()).toBe("add ls list");
  });

  test("unknown completion mode prints help to stderr and rejects", async () => {
    await expect(cmdCompletions("bogus")).rejects.toThrow("unknown completion mode: bogus");

    expect(errors.join("\n")).toContain("usage: maw completions");
  });
});
