import { describe, expect, test } from "bun:test";
import type { OracleEntry } from "../../src/sdk";

function entry(patch: Partial<OracleEntry> = {}): OracleEntry {
  return {
    org: "Soul-Brews-Studio",
    repo: "neo-oracle",
    name: "neo",
    local_path: "/repos/neo-oracle",
    has_psi: false,
    has_fleet_config: false,
    budded_from: null,
    budded_at: null,
    federation_node: null,
    detected_at: "2026-05-18T00:00:00.000Z",
    ...patch,
  };
}

async function captureConsole<T>(fn: () => Promise<T> | T): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    return { result: await fn(), logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe("oracle command final coverage gaps", () => {
  test("runPrune stale path forwards every injectable dependency into stale classification", async () => {
    const prune = await import("../../src/commands/plugins/oracle/impl-prune.ts?coverage-100b-run-prune");
    const now = new Date("2026-05-18T00:00:00.000Z");
    const calls: string[] = [];
    const staleEntries = await prune.runPrune(
      { stale: true },
      {
        readEntries: () => {
          calls.push("readEntries");
          return [entry({ name: "dusty", local_path: "/repos/dusty" })];
        },
        listAwake: async () => {
          calls.push("listAwake");
          return new Set<string>();
        },
        runStale: async (_opts, deps) => {
          calls.push("runStale");
          const entries = deps.readEntries?.() ?? [];
          await deps.listAwake?.();
          deps.now?.();
          return entries.map((e) => ({
            ...e,
            awake: false,
            last_commit: null,
            days_since_commit: null,
            tier: "DEAD" as const,
            recommendation: "not cloned — investigate",
          }));
        },
        promptConfirm: async () => {
          calls.push("unusedPromptConfirm");
          return false;
        },
        readRawCache: () => {
          calls.push("readRawCache");
          return { oracles: [entry({ name: "ignored-cache" })] };
        },
        writeRawCache: () => {
          calls.push("unusedWriteRawCache");
        },
        now: () => {
          calls.push(`now:${now.toISOString()}`);
          return now;
        },
      },
    );

    expect(staleEntries).toHaveLength(1);
    expect(staleEntries[0]).toMatchObject({ entry: { name: "dusty" }, tier: "DEAD" });
    expect(staleEntries[0].reasons).toEqual(["DEAD (>90d)", "not cloned — investigate", "no tmux"]);
    expect(calls).toEqual([
      "readRawCache",
      "runStale",
      "readEntries",
      "listAwake",
      `now:${now.toISOString()}`,
    ]);
  });

  test("cmdOraclePrune force path accepts a fully injected dependency bag and retires candidates", async () => {
    const prune = await import("../../src/commands/plugins/oracle/impl-prune.ts?coverage-100b-cmd-prune");
    const writes: Array<Record<string, unknown>> = [];
    const calls: string[] = [];

    const { logs } = await captureConsole(() =>
      prune.cmdOraclePrune(
        { force: true },
        {
          readEntries: () => {
            calls.push("unusedReadEntries");
            return [];
          },
          listAwake: async () => {
            calls.push("listAwake");
            return new Set<string>();
          },
          runStale: async () => {
            calls.push("unusedRunStale");
            return [];
          },
          promptConfirm: async (msg) => {
            calls.push(`confirm:${msg.includes("Retire 1 oracle")}`);
            return true;
          },
          readRawCache: () => ({
            oracles: [entry({ name: "retire-me", local_path: "", has_psi: false })],
            retired: [entry({ name: "already-retired" })],
          }),
          writeRawCache: (data) => {
            calls.push("writeRawCache");
            writes.push(data);
          },
          now: () => new Date("2026-05-18T00:00:00.000Z"),
        },
      ),
    );

    expect(calls).toEqual(["listAwake", "confirm:true", "writeRawCache"]);
    expect(writes).toHaveLength(1);
    expect((writes[0].oracles as OracleEntry[])).toEqual([]);
    const retired = writes[0].retired as Array<OracleEntry & { retired_at?: string }>;
    expect(retired.map((e) => e.name)).toEqual(["already-retired", "retire-me"]);
    expect(retired[1].retired_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(logs.join("\n")).toContain("Retired 1 oracle");
  });

  test("cmdOracleRegister exercises all injected discovery hooks before filesystem success", async () => {
    const register = await import("../../src/commands/plugins/oracle/impl-register.ts?coverage-100b-register");
    const writes: Array<Record<string, unknown>> = [];
    const calls: string[] = [];

    const { logs } = await captureConsole(() =>
      register.cmdOracleRegister(
        "neo",
        {},
        {
          readRawCache: () => {
            calls.push("readRawCache");
            return { oracles: [] };
          },
          writeRawCache: (data) => {
            calls.push("writeRawCache");
            writes.push(data);
          },
          findInFleetFn: (name) => {
            calls.push(`fleet:${name}`);
            return null;
          },
          findInTmuxFn: async (name) => {
            calls.push(`tmux:${name}`);
            return null;
          },
          findInFilesystemFn: (name) => {
            calls.push(`filesystem:${name}`);
            return { source: "filesystem", entry: entry({ name, org: "DiskOrg", repo: "neo", local_path: "/repos/neo" }) };
          },
        },
      ),
    );

    expect(calls).toEqual(["readRawCache", "fleet:neo", "tmux:neo", "filesystem:neo", "writeRawCache"]);
    expect((writes[0].oracles as OracleEntry[])[0]).toMatchObject({ name: "neo", org: "DiskOrg", local_path: "/repos/neo" });
    expect(logs.join("\n")).toContain("Registered");
    expect(logs.join("\n")).toContain("Path:    /repos/neo");
  });

  test("runStaleScan honors all injected dependencies and all=true keeps non-stale tiers", async () => {
    const stale = await import("../../src/commands/plugins/oracle/impl-stale.ts?coverage-100b-stale");
    const calls: string[] = [];
    const now = new Date("2026-05-18T00:00:00.000Z");

    const results = await stale.runStaleScan(
      { all: true },
      {
        readEntries: () => {
          calls.push("readEntries");
          return [
            entry({ name: "awake", local_path: "/repos/awake" }),
            entry({ name: "slow", local_path: "/repos/slow" }),
          ];
        },
        listAwake: async () => {
          calls.push("listAwake");
          return new Set(["awake"]);
        },
        getLastCommit: (localPath) => {
          calls.push(`commit:${localPath}`);
          return localPath.endsWith("slow") ? "2026-05-08T00:00:00.000Z" : null;
        },
        now: () => {
          calls.push("now");
          return now;
        },
      },
    );

    expect(calls).toEqual(["readEntries", "listAwake", "now", "commit:/repos/awake", "commit:/repos/slow"]);
    expect(results.map((r) => [r.name, r.tier, r.recommendation])).toEqual([
      ["slow", "SLOW", "monitor"],
      ["awake", "ACTIVE", "awake in tmux"],
    ]);
  });
});
