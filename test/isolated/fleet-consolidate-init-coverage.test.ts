/**
 * High-yield isolated coverage for the fleet command pair:
 *   - src/commands/plugins/fleet/fleet-consolidate.ts
 *   - src/commands/plugins/fleet/fleet-init-scan.ts
 *
 * The commands share two useful seams: the SDK transport/path exports and ghq
 * discovery. Keep this file isolated because Bun mock.module() is process-wide.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SANDBOX = mkdtempSync(join(tmpdir(), "maw-fleet-init-consolidate-"));
const FLEET_DIR = join(SANDBOX, "config", "fleet");
const WRITE_FLEET_DIR = join(SANDBOX, "home", "fleet");
const GHQ_ROOT = join(SANDBOX, "ghq");

process.env.MAW_HOME = join(SANDBOX, "home");
process.env.MAW_TEST_MODE = "1";

const sdkPath = import.meta.resolve("../../src/sdk");
const ghqRootPath = import.meta.resolve("../../src/config/ghq-root");
const ghqPath = import.meta.resolve("../../src/core/ghq");

type HostExecHandler = (command: string) => string | Promise<string>;

let hostExecCalls: string[] = [];
let hostExecHandler: HostExecHandler = () => "";
let ghqListReturn: string[] = [];

mock.module(sdkPath, () => ({
  FLEET_DIR,
  tmux: {
    run: async () => "",
  },
  hostExec: async (command: string) => {
    hostExecCalls.push(command);
    return await hostExecHandler(command);
  },
}));

mock.module(ghqRootPath, () => ({
  getGhqRoot: () => GHQ_ROOT,
}));

mock.module(ghqPath, () => ({
  ghqList: async () => ghqListReturn,
}));

const { cmdFleetConsolidate } = await import(
  "../../src/commands/plugins/fleet/fleet-consolidate.ts?fleet-consolidate-init-coverage"
);
const { cmdFleetInit } = await import(
  "../../src/commands/plugins/fleet/fleet-init-scan.ts?fleet-consolidate-init-coverage"
);

function resetSandbox() {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(FLEET_DIR, { recursive: true });
  mkdirSync(WRITE_FLEET_DIR, { recursive: true });
  mkdirSync(join(GHQ_ROOT, "github.com"), { recursive: true });
}

async function captureLogs(fn: () => Promise<unknown>) {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

function stripAnsi(value: string) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function writeDisabledConfig(file: string, payload: unknown) {
  writeFileSync(join(FLEET_DIR, file), JSON.stringify(payload, null, 2));
}

function readFleetConfig(file: string) {
  return JSON.parse(readFileSync(join(WRITE_FLEET_DIR, file), "utf-8"));
}

function repoPath(repo: string) {
  return join(GHQ_ROOT, "github.com", repo);
}

beforeEach(() => {
  resetSandbox();
  hostExecCalls = [];
  hostExecHandler = () => "";
  ghqListReturn = [];
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("cmdFleetConsolidate", () => {
  test("returns early when there are no disabled configs", async () => {
    const output = await captureLogs(() => cmdFleetConsolidate());

    expect(output).toContain("No disabled oracles to consolidate");
    expect(hostExecCalls).toEqual([]);
  });

  test("dry-run reports bad configs, missing repos, discovered branches, and remove intent", async () => {
    writeFileSync(join(FLEET_DIR, "01-bad.json.disabled"), "{not json");
    writeDisabledConfig("02-missing.json.disabled", { windows: [{ repo: "org/missing" }] });
    writeDisabledConfig("03-norepo.json.disabled", { windows: [] });
    writeDisabledConfig("04-present.json.disabled", { windows: [{ repo: "org/present" }] });
    writeDisabledConfig("05-branchbad.json.disabled", { windows: [{ repo: "org/branchbad" }] });
    mkdirSync(repoPath("org/present"), { recursive: true });
    mkdirSync(repoPath("org/branchbad"), { recursive: true });

    hostExecHandler = (command) => {
      if (command.includes("branch --list")) {
        if (command.includes("branchbad")) throw new Error("branch list failed");
        return "* main\n  feature/a\n  master\n  release/b\n";
      }
      throw new Error(`unexpected command: ${command}`);
    };

    const output = await captureLogs(() =>
      cmdFleetConsolidate({ dryRun: true, remove: true })
    );

    expect(output).toContain("Fleet Consolidate");
    expect(output).toContain("(dry run)");
    expect(output).toContain("bad — can't read config");
    expect(output).toContain("missing — repo not found locally (org/missing)");
    expect(output).toContain("norepo — repo not found locally (no repo)");
    expect(output).toContain("present — 2 branches to merge + remove config");
    expect(output).toContain("branchbad — 0 branches to merge + remove config");
    expect(output).toContain("feature/a, release/b");
    expect(output).toContain("5 disabled | 2 branches to merge | 3 no local repo");
    expect(output).toContain("Run without --dry-run to execute");
    expect(hostExecCalls).toHaveLength(2);
  });

  test("executes checkout, merge, abort, commit, push retry, removal, and failure summaries", async () => {
    writeDisabledConfig("01-present.json.disabled", { windows: [{ repo: "org/present" }] });
    writeDisabledConfig("02-checkoutfail.json.disabled", { windows: [{ repo: "org/checkoutfail" }] });
    writeDisabledConfig("03-pushfail.json.disabled", { windows: [{ repo: "org/pushfail" }] });
    mkdirSync(repoPath("org/present"), { recursive: true });
    mkdirSync(repoPath("org/checkoutfail"), { recursive: true });
    mkdirSync(repoPath("org/pushfail"), { recursive: true });

    let presentPlainPushAttempts = 0;

    hostExecHandler = (command) => {
      if (command.includes("branch --list")) {
        if (command.includes("present")) return "* main\n  feature/ok\n  feature/fail\n  master\n";
        if (command.includes("checkoutfail")) return "* main\n  feature/unreached\n";
        return "* main\n";
      }
      if (command.includes("checkout") && command.includes("checkoutfail")) {
        throw new Error("checkout refused");
      }
      if (command.includes("checkout")) return "";
      if (command.includes("merge --no-edit 'feature/fail'")) {
        throw new Error("merge conflict");
      }
      if (command.includes("merge --abort")) return "";
      if (command.includes("merge --no-edit")) return "";
      if (command.includes("status --porcelain")) {
        return command.includes("present") ? " M changed.ts\n" : "";
      }
      if (command.includes("add -A &&")) return "";
      if (command.includes("pull --rebase")) {
        if (command.includes("pushfail")) throw new Error("retry still failed");
        return "";
      }
      if (command.includes(" push 2>/dev/null")) {
        if (command.includes("present")) {
          presentPlainPushAttempts += 1;
          throw new Error("first push failed");
        }
        if (command.includes("pushfail")) throw new Error("push failed");
        return "";
      }
      throw new Error(`unexpected command: ${command}`);
    };

    const output = await captureLogs(() =>
      cmdFleetConsolidate({ remove: true })
    );

    expect(presentPlainPushAttempts).toBe(1);
    expect(hostExecCalls.some((c) => c.includes("merge --no-edit 'feature/ok'"))).toBe(true);
    expect(hostExecCalls.some((c) => c.includes("merge --no-edit 'feature/fail'"))).toBe(true);
    expect(hostExecCalls.some((c) => c.includes("merge --abort"))).toBe(true);
    expect(hostExecCalls.some((c) => c.includes("commit -m 'chore: consolidate before archive'"))).toBe(true);
    expect(hostExecCalls.some((c) => c.includes("pull --rebase"))).toBe(true);

    expect(existsSync(join(FLEET_DIR, "01-present.json.disabled"))).toBe(false);
    expect(existsSync(join(FLEET_DIR, "02-checkoutfail.json.disabled"))).toBe(true);
    expect(existsSync(join(FLEET_DIR, "03-pushfail.json.disabled"))).toBe(true);

    expect(output).toContain("present — 2 branches, 1 merged, push:ok");
    expect(output).toContain("(config removed)");
    expect(output).toContain("checkoutfail — can't checkout main");
    expect(output).toContain("pushfail — 0 branches, 0 merged, push:fail");
    expect(output).toContain("3 processed | 1 pushed | 1 branches merged | 0 no local repo | 1 push failed | 1 configs removed");
    expect(output).toContain("Push failures: pushfail");
  });

  test("prints the post-push remove hint when configs were pushed but --remove was omitted", async () => {
    writeDisabledConfig("01-keepme.json.disabled", { windows: [{ repo: "org/keepme" }] });
    mkdirSync(repoPath("org/keepme"), { recursive: true });

    hostExecHandler = (command) => {
      if (command.includes("branch --list")) return "* main\n";
      if (command.includes("checkout")) return "";
      if (command.includes("status --porcelain")) return "";
      if (command.includes(" push 2>/dev/null")) return "";
      throw new Error(`unexpected command: ${command}`);
    };

    const output = await captureLogs(() => cmdFleetConsolidate());

    expect(existsSync(join(FLEET_DIR, "01-keepme.json.disabled"))).toBe(true);
    expect(output).toContain("keepme — 0 branches, 0 merged, push:ok");
    expect(output).toContain("Use --remove to delete .disabled configs after successful push");
  });
});

describe("cmdFleetInit", () => {
  test("scans ghq repos, groups known oracles, writes worktrees, cleans stale configs, and adds overview", async () => {
    writeFileSync(join(WRITE_FLEET_DIR, "stale.json"), "{}");

    const orgRoot = join(GHQ_ROOT, "github.com", "Soul-Brews-Studio");
    ghqListReturn = [
      join(orgRoot, "pulse-oracle"),
      join(orgRoot, "neo-oracle"),
      join(orgRoot, "homelab"),
      join(orgRoot, "brews-boy-oracle"),
      join(orgRoot, "custom-oracle"),
      join(orgRoot, "not-an-oracle-repo"),
      join(orgRoot, "shadow.wt-001-oracle"),
    ];

    hostExecHandler = (command) => {
      if (command.includes("pulse-oracle.wt-*")) {
        return [
          join(orgRoot, "pulse-oracle.wt-001-fix"),
          join(orgRoot, "pulse-oracle.wt-002-fix"),
        ].join("\n");
      }
      if (command.includes("custom-oracle.wt-*")) {
        return join(orgRoot, "custom-oracle.wt-42-research");
      }
      if (command.includes("neo-oracle.wt-*")) {
        throw new Error("worktree ls failed");
      }
      return "";
    };

    const output = stripAnsi(await captureLogs(() => cmdFleetInit()));
    const files = readdirSync(WRITE_FLEET_DIR).sort();

    expect(files).toEqual([
      "01-pulse.json",
      "03-neo.json",
      "04-homekeeper.json",
      "25-brewsboy.json",
      "50-custom.json",
      "99-overview.json",
    ]);
    expect(files).not.toContain("stale.json");

    expect(readFleetConfig("01-pulse.json")).toEqual({
      name: "01-pulse",
      windows: [
        { name: "pulse-oracle", repo: "Soul-Brews-Studio/pulse-oracle" },
        { name: "pulse-fix", repo: "Soul-Brews-Studio/pulse-oracle.wt-001-fix" },
        { name: "pulse-002-fix", repo: "Soul-Brews-Studio/pulse-oracle.wt-002-fix" },
      ],
    });
    expect(readFleetConfig("04-homekeeper.json")).toEqual({
      name: "04-homekeeper",
      windows: [{ name: "homekeeper-oracle", repo: "Soul-Brews-Studio/homelab" }],
    });
    expect(readFleetConfig("50-custom.json")).toEqual({
      name: "50-custom",
      windows: [
        { name: "custom-oracle", repo: "Soul-Brews-Studio/custom-oracle" },
        { name: "custom-research", repo: "Soul-Brews-Studio/custom-oracle.wt-42-research" },
      ],
    });
    expect(readFleetConfig("99-overview.json")).toEqual({
      name: "99-overview",
      windows: [{ name: "live", repo: "Soul-Brews-Studio/pulse-oracle" }],
      skip_command: true,
    });

    expect(output).toContain("Scanning for oracle repos");
    expect(output).toContain("found: pulse");
    expect(output).toContain("+ 2 worktrees");
    expect(output).toContain("✓ 01-pulse.json — 3 windows");
    expect(output).toContain("✓ 99-overview.json — 1 window");
    expect(output).toContain("6 fleet configs written");
    expect(output).toContain(WRITE_FLEET_DIR);
    expect(output).toContain("maw wake all");
    expect(hostExecCalls).toHaveLength(10);
  });

  test("handles an empty oracle scan without writing overview", async () => {
    const orgRoot = join(GHQ_ROOT, "github.com", "Soul-Brews-Studio");
    ghqListReturn = [
      join(orgRoot, "plain-repo"),
      join(orgRoot, "scratch.wt-001-oracle"),
    ];

    const output = await captureLogs(() => cmdFleetInit());

    expect(readdirSync(WRITE_FLEET_DIR)).toEqual([]);
    expect(hostExecCalls).toEqual([]);
    expect(output).toContain("Writing fleet configs");
    expect(output).toContain("0 fleet configs written");
    expect(output).toContain(WRITE_FLEET_DIR);
  });
});
