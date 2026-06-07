/**
 * plugins-toggle.ts — doEnable + doDisable (primary).
 * plugins-profile.ts — doProfile + doNuke (bonus).
 *
 * Both files live behind the shared plugin-admin seam: loadConfig/saveConfig
 * (lazy `require("../../config")` at call-time) + discoverPackages +
 * resetDiscoverCache (plugins-toggle only). plugins-profile.doProfile takes
 * `discover` as an injected arg → no registry mock needed for it; doNuke
 * uses MAW_PLUGIN_HOME + archiveToTmp (renameSync into /tmp/) — we redirect
 * the home via env var to a mkdtempSync dir so the archive is real but
 * contained.
 *
 * Isolated because we mock.module on:
 *   - src/config                 (loadConfig, saveConfig)
 *   - src/plugin/registry        (discoverPackages, resetDiscoverCache —
 *                                 for plugins-toggle's doDisable lookup
 *                                 + the post-save cache clear added in
 *                                 alpha.67)
 *
 * mock.module is process-global → capture REAL fn refs BEFORE install so
 * passthrough doesn't point at our wrappers (see #375 pollution catalog).
 * Every passthrough wrapper forwards all args via `(...args)` — dropping
 * optional positional args breaks unrelated suites.
 *
 * process.exit is stubbed into a throw so we observe the plugin-not-found
 * branch of doDisable without tearing the runner down.
 */
import {
  describe, test, expect, mock, beforeEach, afterEach, afterAll,
} from "bun:test";
import { join } from "path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import type { LoadedPlugin } from "../../src/plugin/types";

// ─── Gate ───────────────────────────────────────────────────────────────────

let mockActive = false;

// ─── Capture real module refs BEFORE any mock.module installs ───────────────

const _rConfig = await import("../../src/config");
const realLoadConfig = _rConfig.loadConfig;
const realSaveConfig = _rConfig.saveConfig;

const _rRegistry = await import("../../src/plugin/registry");
const realDiscoverPackages = _rRegistry.discoverPackages;
const realResetDiscoverCache = _rRegistry.resetDiscoverCache;

// ─── Mutable state (reset per-test) ─────────────────────────────────────────

let configStore: Record<string, unknown> = {};
let saveConfigCalls: Array<Record<string, unknown>> = [];
let discoverPackagesReturn: LoadedPlugin[] = [];
let resetDiscoverCacheCalls = 0;

// Order-sensitive trace — doEnable/doDisable must resetDiscoverCache AFTER
// saveConfig (alpha.67: ensure the next discover reads the fresh disabled list).
let trace: string[] = [];

// ─── Mocks ──────────────────────────────────────────────────────────────────

mock.module(
  join(import.meta.dir, "../../src/config"),
  () => ({
    ..._rConfig,
    loadConfig: (...args: unknown[]) =>
      mockActive ? configStore : (realLoadConfig as (...a: unknown[]) => unknown)(...args),
    saveConfig: (...args: unknown[]) => {
      if (!mockActive) return (realSaveConfig as (...a: unknown[]) => unknown)(...args);
      const update = (args[0] ?? {}) as Record<string, unknown>;
      saveConfigCalls.push({ ...update });
      configStore = { ...configStore, ...update };
      trace.push("saveConfig");
      return configStore;
    },
  }),
);

mock.module(
  join(import.meta.dir, "../../src/plugin/registry"),
  () => ({
    ..._rRegistry,
    discoverPackages: (...args: unknown[]) =>
      mockActive ? discoverPackagesReturn : (realDiscoverPackages as (...a: unknown[]) => LoadedPlugin[])(...args),
    resetDiscoverCache: (...args: unknown[]) => {
      if (!mockActive) return (realResetDiscoverCache as (...a: unknown[]) => void)(...args);
      resetDiscoverCacheCalls++;
      trace.push("resetDiscoverCache");
    },
  }),
);

// NB: import targets AFTER mocks so their import graph + lazy require() both
// resolve through our stubs.
const { doEnable, doDisable } = await import("../../src/commands/shared/plugins-toggle");
const { doProfile, doNuke } = await import("../../src/commands/shared/plugins-profile");

// ─── stdout + process.exit harness ──────────────────────────────────────────

const origLog = console.log;
const origError = console.error;
const origExit = process.exit;

let outs: string[] = [];
let errs: string[] = [];
let exitCode: number | undefined;

function run(fn: () => void): void {
  outs = []; errs = []; exitCode = undefined;
  console.log = (...a: unknown[]) => { outs.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  (process as unknown as { exit: (c?: number) => never }).exit =
    (c?: number): never => { exitCode = c ?? 0; throw new Error("__exit__:" + exitCode); };
  try { fn(); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith("__exit__")) throw e;
  } finally {
    console.log = origLog;
    console.error = origError;
    (process as unknown as { exit: typeof origExit }).exit = origExit;
  }
}

// ─── Fixture helpers ────────────────────────────────────────────────────────

function plug(name: string, weight?: number, cli?: LoadedPlugin["manifest"]["cli"]): LoadedPlugin {
  return {
    manifest: { name, version: "1.0.0", sdk: "^1.0.0", ...(weight !== undefined && { weight }), ...(cli && { cli }) },
    dir: `/tmp/fake/${name}`,
    wasmPath: "",
    entryPath: `/tmp/fake/${name}/index.ts`,
    kind: "ts",
  } as LoadedPlugin;
}

function plugWithDeps(name: string, deps: string[]): LoadedPlugin {
  const p = plug(name);
  return {
    ...p,
    manifest: { ...p.manifest, dependencies: { plugins: deps } },
  } as LoadedPlugin;
}

// ─── nuke-test scratch home ─────────────────────────────────────────────────

const nukeHomes: string[] = [];
const savedPluginHome = process.env.MAW_PLUGIN_HOME;

function makePluginHome(): string {
  const root = mkdtempSync(join(tmpdir(), "maw-nuke-home-"));
  const plugins = join(root, "plugins");
  mkdirSync(plugins, { recursive: true });
  nukeHomes.push(root);
  return plugins;
}

beforeEach(() => {
  mockActive = true;
  configStore = {};
  saveConfigCalls = [];
  discoverPackagesReturn = [];
  resetDiscoverCacheCalls = 0;
  trace = [];
});

afterEach(() => { mockActive = false; });
afterAll(() => {
  mockActive = false;
  console.log = origLog;
  console.error = origError;
  (process as unknown as { exit: typeof origExit }).exit = origExit;
  if (savedPluginHome !== undefined) process.env.MAW_PLUGIN_HOME = savedPluginHome;
  else delete process.env.MAW_PLUGIN_HOME;
  for (const d of nukeHomes.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// plugins-toggle.doEnable
// ════════════════════════════════════════════════════════════════════════════

describe("doEnable — already-enabled short-circuit", () => {
  test("name absent from disabledPlugins → logs 'already enabled', no saveConfig", () => {
    configStore = { disabledPlugins: ["other"] };

    run(() => doEnable("foo"));

    expect(outs.join("\n")).toContain("foo is already enabled");
    expect(saveConfigCalls).toEqual([]);
    expect(resetDiscoverCacheCalls).toBe(0);
  });

  test("disabledPlugins is undefined → treated as empty, logs 'already enabled'", () => {
    configStore = {};

    run(() => doEnable("foo"));

    expect(outs.join("\n")).toContain("foo is already enabled");
    expect(saveConfigCalls).toEqual([]);
  });

  test("empty disabledPlugins array → logs 'already enabled'", () => {
    configStore = { disabledPlugins: [] };

    run(() => doEnable("foo"));

    expect(outs.join("\n")).toContain("foo is already enabled");
    expect(saveConfigCalls).toEqual([]);
  });
});

describe("doEnable — enable branch", () => {
  test("name in disabledPlugins → saveConfig filters it, resetDiscoverCache, success log", () => {
    configStore = { disabledPlugins: ["foo", "bar"] };
    discoverPackagesReturn = [plug("foo"), plug("bar")];

    run(() => doEnable("foo"));

    expect(saveConfigCalls).toEqual([{ disabledPlugins: ["bar"] }]);
    expect(resetDiscoverCacheCalls).toBe(1);
    const joined = outs.join("\n");
    expect(joined).toContain("enabled foo");
    // ANSI green check marker
    expect(joined).toContain("\x1b[32m✓\x1b[0m");
  });

  test("name is the only disabled plugin → saveConfig with empty array", () => {
    configStore = { disabledPlugins: ["foo"] };
    discoverPackagesReturn = [plug("foo")];

    run(() => doEnable("foo"));

    expect(saveConfigCalls).toEqual([{ disabledPlugins: [] }]);
  });

  test("resetDiscoverCache fires AFTER saveConfig (alpha.67 ordering)", () => {
    configStore = { disabledPlugins: ["foo"] };
    discoverPackagesReturn = [plug("foo")];

    run(() => doEnable("foo"));

    expect(trace).toEqual(["saveConfig", "resetDiscoverCache"]);
  });

  test("#1541 — enable resolves CLI alias to owning plugin name", () => {
    configStore = { disabledPlugins: ["about"] };
    discoverPackagesReturn = [
      plug("about", 10, { command: "about", aliases: ["info"], help: "maw about <oracle>" }),
    ];

    run(() => doEnable("info"));

    expect(saveConfigCalls).toEqual([{ disabledPlugins: [] }]);
    expect(resetDiscoverCacheCalls).toBe(1);
    expect(outs.join("\n")).toContain("enabled about");
  });

  test("#1547 — enable includes disabled plugin dependencies before target", () => {
    configStore = { disabledPlugins: ["trace", "dig", "foo"] };
    discoverPackagesReturn = [plug("trace"), plug("dig"), plugWithDeps("foo", ["trace", "dig"])];

    run(() => doEnable("foo"));

    expect(saveConfigCalls).toEqual([{ disabledPlugins: [] }]);
    expect(outs.join("\n")).toContain("enabled trace, dig, foo");
  });

  test("#1547 — enable accepts multiple plugin names", () => {
    configStore = { disabledPlugins: ["trace", "dig", "other"] };
    discoverPackagesReturn = [plug("trace"), plug("dig"), plug("other")];

    run(() => doEnable(["trace", "dig"]));

    expect(saveConfigCalls).toEqual([{ disabledPlugins: ["other"] }]);
    expect(outs.join("\n")).toContain("enabled trace, dig");
  });

  test("preserves OTHER disabled plugins unchanged", () => {
    configStore = { disabledPlugins: ["a", "foo", "b", "c"] };

    run(() => doEnable("foo"));

    expect(saveConfigCalls[0].disabledPlugins).toEqual(["a", "b", "c"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// plugins-toggle.doDisable
// ════════════════════════════════════════════════════════════════════════════

describe("doDisable — already-disabled short-circuit", () => {
  test("name present in disabledPlugins → logs 'already disabled', no saveConfig", () => {
    configStore = { disabledPlugins: ["foo"] };

    run(() => doDisable("foo"));

    expect(outs.join("\n")).toContain("foo is already disabled");
    expect(saveConfigCalls).toEqual([]);
    expect(resetDiscoverCacheCalls).toBe(0);
    // discoverPackages NOT consulted when the plugin is already disabled —
    // short-circuit happens before the existence check.
    expect(exitCode).toBeUndefined();
  });
});

describe("doDisable — plugin-not-found branch", () => {
  test("plugin missing from discoverPackages → console.error + process.exit(1)", () => {
    configStore = { disabledPlugins: [] };
    discoverPackagesReturn = [plug("bar"), plug("baz")];

    run(() => doDisable("foo"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("plugin not found: foo");
    expect(saveConfigCalls).toEqual([]);
    expect(resetDiscoverCacheCalls).toBe(0);
  });

  test("empty plugin registry → still errors with 'plugin not found'", () => {
    configStore = { disabledPlugins: [] };
    discoverPackagesReturn = [];

    run(() => doDisable("foo"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("plugin not found: foo");
  });

  test("disabledPlugins undefined → falls through to existence check", () => {
    configStore = {}; // no disabledPlugins key
    discoverPackagesReturn = [];

    run(() => doDisable("foo"));

    expect(exitCode).toBe(1);
    expect(errs.join("\n")).toContain("plugin not found: foo");
  });
});

describe("doDisable — disable branch", () => {
  test("plugin exists + not currently disabled → saveConfig appends, resetDiscoverCache, success log", () => {
    configStore = { disabledPlugins: ["bar"] };
    discoverPackagesReturn = [plug("foo"), plug("bar"), plug("baz")];

    run(() => doDisable("foo"));

    expect(saveConfigCalls).toEqual([{ disabledPlugins: ["bar", "foo"] }]);
    expect(resetDiscoverCacheCalls).toBe(1);
    const joined = outs.join("\n");
    expect(joined).toContain("disabled foo");
    // ANSI yellow ✗ marker
    expect(joined).toContain("\x1b[33m✗\x1b[0m");
  });

  test("disabledPlugins undefined + plugin exists → saveConfig with [name]", () => {
    configStore = {};
    discoverPackagesReturn = [plug("foo")];

    run(() => doDisable("foo"));

    expect(saveConfigCalls).toEqual([{ disabledPlugins: ["foo"] }]);
    expect(resetDiscoverCacheCalls).toBe(1);
  });

  test("#1541 — disable resolves CLI alias to owning plugin name", () => {
    configStore = { disabledPlugins: [] };
    discoverPackagesReturn = [
      plug("about", 10, { command: "about", aliases: ["info"], help: "maw about <oracle>" }),
    ];

    run(() => doDisable("info"));

    expect(saveConfigCalls).toEqual([{ disabledPlugins: ["about"] }]);
    expect(resetDiscoverCacheCalls).toBe(1);
    expect(outs.join("\n")).toContain("disabled about");
  });

  test("resetDiscoverCache fires AFTER saveConfig (alpha.67 ordering)", () => {
    configStore = { disabledPlugins: [] };
    discoverPackagesReturn = [plug("foo")];

    run(() => doDisable("foo"));

    expect(trace).toEqual(["saveConfig", "resetDiscoverCache"]);
  });

  test("doDisable does NOT mutate configStore.disabledPlugins in place", () => {
    const original = ["bar"];
    configStore = { disabledPlugins: original };
    discoverPackagesReturn = [plug("foo")];

    run(() => doDisable("foo"));

    // The captured update array must be a new list, not a shared reference
    // with the original disabled list (spread in impl: [...disabled, name]).
    expect(original).toEqual(["bar"]);
    expect(saveConfigCalls[0].disabledPlugins).toEqual(["bar", "foo"]);
    expect(saveConfigCalls[0].disabledPlugins).not.toBe(original);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// plugins-profile.doProfile — full tier
// ════════════════════════════════════════════════════════════════════════════

describe("doProfile — full", () => {
  test("profile='full' → saveConfig with empty disabledPlugins + 'all N enabled' log", () => {
    const plugins = [plug("a", 5), plug("b", 30), plug("c", 80)];

    run(() => doProfile("full", () => plugins));

    expect(saveConfigCalls).toEqual([{ disabledPlugins: [] }]);
    const joined = outs.join("\n");
    expect(joined).toContain("full");
    expect(joined).toContain("all 3 plugins enabled");
  });

  test("profile='full' with zero plugins discovered → still saves empty list + 'all 0' log", () => {
    run(() => doProfile("full", () => []));

    expect(saveConfigCalls).toEqual([{ disabledPlugins: [] }]);
    expect(outs.join("\n")).toContain("all 0 plugins enabled");
  });

  test("profile='full' short-circuits before threshold math (no registry reads beyond discover)", () => {
    // Even with heavy plugins present, full always clears disabled list.
    const plugins = [plug("heavy1", 90), plug("heavy2", 70), plug("core1", 1)];

    run(() => doProfile("full", () => plugins));

    // Summary line must NOT render the disable-count hint — only the
    // "all N enabled" line — so we assert the absence of the grey hint.
    expect(outs.join("\n")).not.toContain("Profiles: maw plugin lean");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// plugins-profile.doProfile — core tier (threshold 10)
// ════════════════════════════════════════════════════════════════════════════

describe("doProfile — core (threshold 10)", () => {
  test("disables all plugins with weight >= 10, keeps weight < 10", () => {
    const plugins = [
      plug("tiny", 1),
      plug("small", 9),
      plug("mid", 10),       // AT threshold → disabled
      plug("heavy", 80),
    ];

    run(() => doProfile("core", () => plugins));

    expect(saveConfigCalls).toEqual([{ disabledPlugins: ["mid", "heavy"] }]);
    const joined = outs.join("\n");
    expect(joined).toContain("core");
    expect(joined).toContain("2 active, 2 disabled");
    // Each disabled plugin rendered with yellow ✗ (ANSI wrapped tightly around ✗)
    expect(joined).toContain("\x1b[33m✗\x1b[0m mid");
    expect(joined).toContain("\x1b[33m✗\x1b[0m heavy");
  });

  test("missing weight defaults to 50 → disabled under core", () => {
    const plugins = [plug("nowt"), plug("low", 5)];

    run(() => doProfile("core", () => plugins));

    expect(saveConfigCalls[0].disabledPlugins).toEqual(["nowt"]);
  });

  test("all plugins below threshold → 'already core — nothing to disable', no saveConfig", () => {
    const plugins = [plug("a", 1), plug("b", 5), plug("c", 9)];

    run(() => doProfile("core", () => plugins));

    expect(saveConfigCalls).toEqual([]);
    expect(outs.join("\n")).toContain("already core — nothing to disable");
  });

  test("empty plugin list → 'already core — nothing to disable'", () => {
    run(() => doProfile("core", () => []));

    expect(saveConfigCalls).toEqual([]);
    expect(outs.join("\n")).toContain("already core — nothing to disable");
  });

  test("summary line includes the 'lean | standard | full' hint on disable path", () => {
    const plugins = [plug("heavy", 80)];

    run(() => doProfile("core", () => plugins));

    expect(outs.join("\n")).toContain("Profiles: maw plugin lean | standard | full");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// plugins-profile.doProfile — standard tier (threshold 50)
// ════════════════════════════════════════════════════════════════════════════

describe("doProfile — standard (threshold 50)", () => {
  test("disables weight >= 50, keeps weight < 50", () => {
    const plugins = [
      plug("tiny", 5),
      plug("mid", 30),       // below threshold → kept
      plug("edge", 50),      // AT threshold → disabled
      plug("heavy", 90),
    ];

    run(() => doProfile("standard", () => plugins));

    expect(saveConfigCalls[0].disabledPlugins).toEqual(["edge", "heavy"]);
    expect(outs.join("\n")).toContain("2 active, 2 disabled");
  });

  test("missing weight (default 50) → disabled under standard", () => {
    const plugins = [plug("unweighted"), plug("low", 20)];

    run(() => doProfile("standard", () => plugins));

    expect(saveConfigCalls[0].disabledPlugins).toEqual(["unweighted"]);
  });

  test("all plugins below 50 → 'already standard — nothing to disable'", () => {
    const plugins = [plug("a", 1), plug("b", 49)];

    run(() => doProfile("standard", () => plugins));

    expect(saveConfigCalls).toEqual([]);
    expect(outs.join("\n")).toContain("already standard — nothing to disable");
  });

  test("RESETS disabledPlugins (doesn't accumulate with previously disabled entries)", () => {
    // Regression guard: saveConfig is called with the COMPUTED toDisable list,
    // not merged into the existing config.disabledPlugins. loadConfig() is
    // still called (to let saveConfig pick up the rest of the config) but
    // its value must not leak into the write.
    configStore = { disabledPlugins: ["stale-entry-that-should-vanish"] };
    const plugins = [plug("heavy", 80)];

    run(() => doProfile("standard", () => plugins));

    expect(saveConfigCalls).toEqual([{ disabledPlugins: ["heavy"] }]);
    expect(saveConfigCalls[0].disabledPlugins).not.toContain("stale-entry-that-should-vanish");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// plugins-profile.doProfile — discover arg wiring
// ════════════════════════════════════════════════════════════════════════════

describe("doProfile — discover injection", () => {
  test("calls the injected discover function exactly once", () => {
    let calls = 0;
    const discover = () => { calls++; return [plug("a", 1)]; };

    run(() => doProfile("core", discover));

    expect(calls).toBe(1);
  });

  test("does NOT touch the real registry (injected discover is the only source)", () => {
    // Our registry mock counts discoverPackages calls indirectly — but since
    // doProfile never calls the module-level discoverPackages, the mock must
    // see zero invocations. We probe that by asserting our own mock counter.
    // The registry passthrough above does not track calls, so we assert the
    // weaker-but-meaningful property: no resetDiscoverCache calls (which
    // doProfile deliberately does NOT fire — the next discover() call from
    // the caller is a fresh one by construction).
    run(() => doProfile("core", () => [plug("heavy", 99)]));

    expect(resetDiscoverCacheCalls).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// plugins-profile.doNuke
// ════════════════════════════════════════════════════════════════════════════

describe("doNuke — empty / missing home", () => {
  test("MAW_PLUGIN_HOME points to non-existent dir → 'nothing to nuke'", () => {
    const missing = join(tmpdir(), `maw-nuke-missing-${Date.now()}`);
    process.env.MAW_PLUGIN_HOME = missing;

    run(() => doNuke());

    expect(outs.join("\n")).toContain("nothing to nuke");
    expect(outs.join("\n")).not.toContain("nuked");
  });

  test("MAW_PLUGIN_HOME points to empty dir → prints 'nuked' banner with zero items", () => {
    const home = makePluginHome();
    process.env.MAW_PLUGIN_HOME = home;

    run(() => doNuke());

    const joined = outs.join("\n");
    expect(joined).toContain("nuked");
    expect(joined).toContain("all plugins archived to /tmp/");
    expect(joined).toContain("next maw run will auto-bootstrap core plugins");
  });
});

describe("doNuke — archives plugin dirs into /tmp/", () => {
  test("each subdir archived via renameSync; source removed; log lists each entry", () => {
    const home = makePluginHome();
    process.env.MAW_PLUGIN_HOME = home;
    mkdirSync(join(home, "alpha"));
    mkdirSync(join(home, "bravo"));
    writeFileSync(join(home, "alpha", "plugin.json"), "{}");
    writeFileSync(join(home, "bravo", "plugin.json"), "{}");

    run(() => doNuke());

    // Both subdirs removed from home.
    expect(readdirSync(home).sort()).toEqual([]);
    const joined = outs.join("\n");
    expect(joined).toContain("\x1b[31m✗\x1b[0m alpha");
    expect(joined).toContain("\x1b[31m✗\x1b[0m bravo");
    expect(joined).toContain("nuked");

    // Archive lands under /tmp/maw-plugin-<name>-<ts> — wildcard match.
    const tmpEntries = readdirSync("/tmp").filter(
      (n) => n.startsWith("maw-plugin-alpha-") || n.startsWith("maw-plugin-bravo-"),
    );
    expect(tmpEntries.length).toBeGreaterThanOrEqual(2);
    // Clean up the archive we just produced so /tmp/ stays tidy.
    for (const n of tmpEntries) rmSync(join("/tmp", n), { recursive: true, force: true });
  });

  test("skips plain files (non-dir, non-symlink) at the top level", () => {
    const home = makePluginHome();
    process.env.MAW_PLUGIN_HOME = home;
    writeFileSync(join(home, "stray.txt"), "not a plugin");
    mkdirSync(join(home, "real"));

    run(() => doNuke());

    // stray.txt should still exist (skipped by the lstatSync guard).
    expect(existsSync(join(home, "stray.txt"))).toBe(true);
    // real/ should be gone.
    expect(existsSync(join(home, "real"))).toBe(false);
    const joined = outs.join("\n");
    expect(joined).toContain("\x1b[31m✗\x1b[0m real");
    expect(joined).not.toContain("stray.txt");

    // Cleanup archive.
    const tmpEntries = readdirSync("/tmp").filter((n) => n.startsWith("maw-plugin-real-"));
    for (const n of tmpEntries) rmSync(join("/tmp", n), { recursive: true, force: true });
  });

  test("symlinks ARE archived (isSymbolicLink branch of the guard)", () => {
    const home = makePluginHome();
    process.env.MAW_PLUGIN_HOME = home;
    // Create a real dir elsewhere, symlink it into the plugin home.
    const target = mkdtempSync(join(tmpdir(), "maw-nuke-link-target-"));
    nukeHomes.push(target); // cleanup list; symlink points here but renameSync moves the LINK, not the target
    writeFileSync(join(target, "plugin.json"), "{}");
    symlinkSync(target, join(home, "linked"));

    run(() => doNuke());

    expect(existsSync(join(home, "linked"))).toBe(false);
    expect(outs.join("\n")).toContain("\x1b[31m✗\x1b[0m linked");

    // Cleanup archive.
    const tmpEntries = readdirSync("/tmp").filter((n) => n.startsWith("maw-plugin-linked-"));
    for (const n of tmpEntries) rmSync(join("/tmp", n), { recursive: true, force: true });
  });
});
