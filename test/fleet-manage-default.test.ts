/**
 * fleet-manage.ts — default-suite coverage for fleet list/renumber helpers.
 */
import { describe, expect, test } from "bun:test";
import {
  cmdFleetLs,
  cmdFleetRenumber,
  fleetManageDeps,
  renderFleetLs,
  type FleetManageDeps,
} from "../src/commands/shared/fleet-manage";
import type { FleetEntry, FleetSession } from "../src/commands/shared/fleet-load";

const session = (name: string, windows: Array<{ name: string; repo?: string }> = []): FleetSession => ({
  name,
  windows: windows.map(w => ({ name: w.name, repo: w.repo ?? "Soul-Brews-Studio/example" })),
});

const entry = (file: string, num: number, groupName: string, fleetSession: FleetSession): FleetEntry => ({
  file,
  num,
  groupName,
  session: fleetSession,
});

const text = (lines: string[]) => lines.join("\n");

function makeDeps(entries: FleetEntry[], options: {
  files?: string[];
  running?: string[];
  exists?: (path: string) => boolean;
  tmuxThrowsFor?: Set<string>;
} = {}) {
  const logs: string[] = [];
  const writes: Array<{ path: string; contents: string }> = [];
  const renames: Array<{ from: string; to: string }> = [];
  const unlinks: string[] = [];
  const tmuxRuns: string[][] = [];

  const deps = fleetManageDeps({
    loadFleetEntries: () => entries,
    getSessionNames: async () => options.running ?? [],
    readdirSync: () => options.files ?? [],
    fleetDir: "/fleet",
    writeFile: async (path: string, contents: string) => {
      writes.push({ path, contents });
      return undefined;
    },
    renameSync: (from: string, to: string) => { renames.push({ from, to }); },
    existsSync: (path: string) => options.exists?.(path) ?? true,
    unlinkSync: (path: string) => { unlinks.push(path); },
    join: (...parts: string[]) => parts.join("/"),
    tmuxRun: async (...args: string[]) => {
      tmuxRuns.push(args);
      const runningName = args[2];
      if (options.tmuxThrowsFor?.has(runningName)) throw new Error("tmux rename failed");
      return "";
    },
    log: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); },
  } satisfies Partial<FleetManageDeps>);

  return { deps, logs, writes, renames, unlinks, tmuxRuns };
}

describe("fleetManageDeps", () => {
  test("exposes production defaults with safe overrides", () => {
    const loadFleetEntries = () => [] as FleetEntry[];
    const deps = fleetManageDeps({ loadFleetEntries });

    expect(deps.loadFleetEntries).toBe(loadFleetEntries);
    expect(typeof deps.getSessionNames).toBe("function");
    expect(typeof deps.readdirSync).toBe("function");
    expect(typeof deps.fleetDir).toBe("string");
    expect(typeof deps.writeFile).toBe("function");
    expect(typeof deps.renameSync).toBe("function");
    expect(typeof deps.existsSync).toBe("function");
    expect(typeof deps.unlinkSync).toBe("function");
    expect(deps.join("a", "b")).toBe("a/b");
    expect(typeof deps.tmuxRun).toBe("function");
    expect(typeof deps.log).toBe("function");
  });
});

describe("renderFleetLs", () => {
  test("renders running/stopped sessions, conflicts, invalid entries, and fallback names", () => {
    const lines = renderFleetLs([
      entry("01-alpha.json", 1, "alpha", session("01-alpha", [{ name: "alpha-oracle" }])),
      entry("01-beta.json", 1, "beta", session("01-beta", [])),
      entry("bad.json", 3, "fallback", { windows: "bad" } as unknown as FleetSession),
      entry(".json", 4, "", {} as unknown as FleetSession),
    ], 2, ["01-alpha"]);

    const out = text(lines);
    expect(out).toContain("Fleet Configs");
    expect(out).toContain("4 active, 2 disabled");
    expect(out).toContain("01-alpha");
    expect(out).toContain("running");
    expect(out).toContain("01-beta");
    expect(out).toContain("stopped");
    expect(out).toContain("CONFLICT");
    expect(out).toContain("INVALID");
    expect(out).toContain("fallback");
    expect(out).toContain("(unnamed)");
    expect(out).toContain("maw fleet renumber");
  });
});

describe("cmdFleetLs", () => {
  test("loads entries, counts disabled configs, gets running sessions, and prints rendered rows", async () => {
    const h = makeDeps([
      entry("01-alpha.json", 1, "alpha", session("01-alpha", [{ name: "alpha-oracle" }])),
    ], {
      files: ["01-alpha.json", "02-beta.json.disabled", "notes.txt", "03-gamma.disabled"],
      running: ["01-alpha"],
    });

    await cmdFleetLs(h.deps);

    const out = text(h.logs);
    expect(out).toContain("1 active, 2 disabled");
    expect(out).toContain("01-alpha");
    expect(out).toContain("running");
  });
});

describe("cmdFleetRenumber", () => {
  test("prints a clean message and stops before side effects when no conflicts exist", async () => {
    const h = makeDeps([
      entry("01-alpha.json", 1, "alpha", session("01-alpha")),
      entry("02-beta.json", 2, "beta", session("02-beta")),
    ]);

    await cmdFleetRenumber(h.deps);

    expect(text(h.logs)).toContain("No conflicts found");
    expect(h.writes).toEqual([]);
    expect(h.renames).toEqual([]);
    expect(h.unlinks).toEqual([]);
    expect(h.tmuxRuns).toEqual([]);
  });

  test("renumbers conflicting configs, skips overview, updates tmux when possible, and logs failures", async () => {
    const h = makeDeps([
      entry("02-delta.json", 2, "delta", session("02-delta")),
      entry("02-bravo.json", 2, "bravo", session("old-bravo")),
      entry("99-overview.json", 99, "overview", session("99-overview")),
      entry("02-alpha.json", 2, "alpha", session("02-alpha")),
      entry("02-charlie.json", 2, "charlie", session("02-charlie")),
    ], {
      running: ["02-alpha", "99-charlie"],
      tmuxThrowsFor: new Set(["99-charlie"]),
    });

    await cmdFleetRenumber(h.deps);

    expect(h.writes.map(w => w.path)).toEqual([
      "/fleet/.tmp-01-alpha.json",
      "/fleet/.tmp-03-charlie.json",
      "/fleet/.tmp-04-delta.json",
    ]);
    expect(JSON.parse(h.writes[0].contents).name).toBe("01-alpha");
    expect(h.renames).toEqual([
      { from: "/fleet/.tmp-01-alpha.json", to: "/fleet/01-alpha.json" },
      { from: "/fleet/.tmp-03-charlie.json", to: "/fleet/03-charlie.json" },
      { from: "/fleet/.tmp-04-delta.json", to: "/fleet/04-delta.json" },
    ]);
    expect(h.unlinks).toEqual([
      "/fleet/02-alpha.json",
      "/fleet/02-charlie.json",
      "/fleet/02-delta.json",
    ]);
    expect(h.tmuxRuns).toEqual([
      ["rename-session", "-t", "02-alpha", "01-alpha"],
      ["rename-session", "-t", "99-charlie", "03-charlie"],
    ]);

    const out = text(h.logs);
    expect(out).toContain("Renumbering fleet");
    expect(out).toContain("02-alpha.json");
    expect(out).toContain("tmux: 02-alpha → 01-alpha");
    expect(out).toContain("02-bravo.json");
    expect(out).toContain("(unchanged)");
    expect(out).toContain("tmux rename failed: 99-charlie");
    expect(out).toContain("02-delta.json");
    expect(out).toContain("Done.");
    expect(out).toContain("4 configs renumbered");
    expect(out).not.toContain("99-overview.json");
  });

  test("does not unlink a missing old config while still writing the replacement", async () => {
    const h = makeDeps([
      entry("05-alpha.json", 5, "alpha", session("05-alpha")),
      entry("05-beta.json", 5, "beta", session("05-beta")),
    ], {
      exists: path => !path.endsWith("05-alpha.json"),
    });

    await cmdFleetRenumber(h.deps);

    expect(h.writes.map(w => w.path)).toEqual(["/fleet/.tmp-01-alpha.json", "/fleet/.tmp-02-beta.json"]);
    expect(h.unlinks).toEqual(["/fleet/05-beta.json"]);
    expect(text(h.logs)).toContain("02-beta.json");
  });
});
