import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let cwd = "";
let ghqRoot = "";
let logs: string[] = [];
let hostExecCalls: string[] = [];

const original = {
  cwd: process.cwd(),
  log: console.log,
  fetch: globalThis.fetch,
};

mock.module("maw-js/sdk", () => ({
  hostExec: async (command: string) => {
    hostExecCalls.push(command);
    if (command === "ghq list -p 2>/dev/null") return "";
    throw new Error(`unexpected hostExec command: ${command}`);
  },
}));

mock.module("maw-js/config/ghq-root", () => ({
  getGhqRoot: () => ghqRoot,
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleet: () => [],
}));

const { cmdDream } = await import("../../src/vendor/mpr-plugins/dream/impl.ts?coverage-vendor-dream-bud-dream-default");

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "maw-dream-default-cwd-"));
  ghqRoot = mkdtempSync(join(tmpdir(), "maw-dream-default-ghq-"));
  logs = [];
  hostExecCalls = [];
  process.chdir(cwd);
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  globalThis.fetch = (async () => ({ ok: false, json: async () => ({ results: [] }) })) as typeof fetch;
});

afterEach(() => {
  process.chdir(original.cwd);
  console.log = original.log;
  globalThis.fetch = original.fetch;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(ghqRoot, { recursive: true, force: true });
});

describe("dream default offline scan coverage", () => {
  test("renders and saves the default offline briefing when no repos are discoverable", async () => {
    await cmdDream({} as never);

    const output = logs.join("\n");
    expect(output).toContain("Dream");
    expect(output).toContain("dreaming...");
    expect(output).toContain("0 active");
    expect(output).toContain("saved →");
    expect(hostExecCalls).toEqual(["ghq list -p 2>/dev/null"]);

    const dreamDir = join(cwd, "ψ", "writing", "dreams");
    const files = readdirSync(dreamDir).filter((entry) => entry.endsWith("_dream.md"));
    expect(files).toHaveLength(1);
    const saved = readFileSync(join(dreamDir, files[0]!), "utf8");
    expect(saved).toContain("**Scanned**: 0 repos");
    expect(saved).toContain("**Oracle KB**: offline");
  });
});
