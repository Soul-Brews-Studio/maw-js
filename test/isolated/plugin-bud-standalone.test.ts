import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const budDir = join(root, "src/vendor/mpr-plugins/bud");
let hostExecCalls: string[] = [];
let wakeCalls: Array<{ oracle: string; opts: Record<string, unknown> }> = [];
let splitCalls: string[] = [];
let cloned: string[] = [];
let signals: unknown[] = [];
let nicknames: unknown[] = [];
let config: Record<string, unknown> = {};

function parseFlags(args: string[], spec: Record<string, unknown>) {
  const out: Record<string, any> & { _: string[] } = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const type = spec[arg];
    if (type === Boolean) out[arg] = true;
    else if (type === Number) out[arg] = Number(args[++i]);
    else if (type === String) out[arg] = args[++i];
    else out._.push(arg);
  }
  return out;
}

const sdkMock = {
  parseFlags,
  loadConfig: () => config,
  getGhqRoot: () => "/tmp/ghq",
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    if (cmd.includes("pane_current_path")) return "/tmp/ghq/github.com/Acme/parent-oracle";
    return "";
  },
  loadFleetCore: () => [],
  fleetLoadDirForWrite: () => "/tmp/fleet",
  loadFleetEntries: () => [],
  ghqFind: async () => null,
  legacyMawPath: (...parts: string[]) => join("/tmp/legacy-maw", ...parts),
  mawStatePath: (...parts: string[]) => join("/tmp/state-maw", ...parts),
  parseWakeTarget: () => null,
  ensureCloned: async (slug: string) => { cloned.push(slug); },
  normalizeTarget: (raw: string) => raw.replace(/\/$/, "").replace(/\.git$/, ""),
  assertValidOracleName: (name: string) => {
    if (name.endsWith("-view")) throw new Error("Oracle name cannot end in '-view'");
  },
  validateNickname: (raw: string) => raw.includes("\n") ? { ok: false, error: "nickname must be a single line" } : { ok: true, value: raw.trim() },
  writeNickname: (repoPath: string, nickname: string) => nicknames.push({ repoPath, nickname }),
  setCachedNickname: (name: string, nickname: string) => nicknames.push({ name, nickname }),
  writeSignal: (...args: unknown[]) => { signals.push(args); return "/tmp/signal.json"; },
  cmdWake: async (oracle: string, opts: Record<string, unknown>) => {
    wakeCalls.push({ oracle, opts });
    return "woke";
  },
  fetchIssuePrompt: async (num: number, repo?: string) => `issue ${num} from ${repo}`,
  shouldAutoWake: () => ({ wake: true, reason: "bud always wakes" }),
  cmdSplit: async (target: string) => { splitCalls.push(target); },
};

mock.module("maw-js/sdk", () => sdkMock);
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => sdkMock);

const { command, default: budHandler } = await import("../../src/vendor/mpr-plugins/bud/index.ts");

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSources(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function importSpecs(source: string): string[] {
  const specs = new Set<string>();
  const re = /\b(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) specs.add(match[1] ?? match[2]);
  return [...specs];
}

beforeEach(() => {
  hostExecCalls = [];
  wakeCalls = [];
  splitCalls = [];
  cloned = [];
  signals = [];
  nicknames = [];
  config = {};
  delete process.env.MAW_BUD_OWNER;
  delete process.env.TMUX;
});

describe("bud plugin standalone boundary (#2314)", () => {
  test("all bud sources use SDK or local/platform imports only", () => {
    const imports = walkSources(budDir).flatMap((file) => importSpecs(readFileSync(file, "utf8")));
    const forbidden = imports.filter((spec) =>
      spec.startsWith("maw-js/core/")
      || spec.startsWith("maw-js/commands/shared/")
      || spec.startsWith("maw-js/cli/")
      || spec === "maw-js/config"
      || spec.startsWith("maw-js/config/")
      || spec.startsWith("maw-js/plugin")
      || spec.startsWith("../split/")
      || spec.includes("../../../../core"),
    );

    expect(command).toMatchObject({ name: "bud" });
    expect(forbidden).toEqual([]);
    expect(imports).toContain("maw-js/sdk");
  });

  test("CLI usage and invalid argument paths return InvokeResult errors without side effects", async () => {
    const help = await budHandler({ source: "cli", args: ["--help"] } as any);
    expect(help.ok).toBe(false);
    expect(help.error).toContain("usage: maw bud <name>");

    const flagName = await budHandler({ source: "cli", args: ["--dry-run"] } as any);
    expect(flagName.ok).toBe(false);
    expect(flagName.error).toContain("usage: maw bud <name>");

    const missingStem = await budHandler({ source: "cli", args: ["--from-repo", "/repo"] } as any);
    expect(missingStem).toEqual({ ok: false, error: "--from-repo requires --stem <stem> (oracle stem, no -oracle suffix)" });
    expect(hostExecCalls).toEqual([]);
  });

  test("dry-run root bud stays non-destructive while exercising cmdBud through SDK seams", async () => {
    const result = await budHandler({
      source: "cli",
      args: ["sprout", "--root", "--org", "Acme", "--dry-run", "--nickname", "Sprout"],
    } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("Root Bud");
    expect(result.output).toContain("[dry-run] would create repo: Acme/sprout-oracle");
    expect(result.output).toContain("[dry-run] would write nickname: Sprout");
    expect(hostExecCalls).toEqual([]);
    expect(wakeCalls).toEqual([]);
    expect(cloned).toEqual([]);
  });

  test("API requires a name and can run a dry-run root bud", async () => {
    const missing = await budHandler({ source: "api", args: {} } as any);
    expect(missing).toEqual({ ok: false, error: "name required" });

    const ok = await budHandler({ source: "api", args: { name: "api-bud", root: true, org: "Acme", dryRun: true } } as any);
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain("Acme/api-bud-oracle");
  });
});
