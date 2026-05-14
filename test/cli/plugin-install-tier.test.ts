/**
 * test/cli/plugin-install-tier.test.ts — #1338 bulk-install --tier flag.
 *
 * Validates the new `maw plugin install --tier <core|standard|extra>
 * [--from <owner/repo>]` surface added in install-tier-impl.ts.
 *
 * ## Mocking strategy (per #1335 retro)
 *
 * - NO `mock.module()` — known to leak across files when the same module is
 *   stubbed from multiple "isolated" tests. We use:
 *     1. `globalThis.fetch` override (saved + restored in afterEach) for
 *        GitHub raw + tarball requests.
 *     2. `MAW_PLUGINS_DIR` + `MAW_PLUGINS_LOCK` env scoping to redirect
 *        ~/.maw/plugins/ into a per-test tmp dir.
 *     3. Planting on-disk plugin dirs to simulate the "already-installed"
 *        idempotency branch (cmdPluginInstallTier checks
 *        `existsSync(<installRoot>/<name>)`).
 *
 * - Avoid mocking `process.stderr.write` (Bun 1.3.13 Linux epoll bug, #1308).
 *   We rely on stdout/stderr being benign here — the impl prints summary
 *   lines via console.log, not stderr.
 *
 * ## Placement
 *
 * test/cli/ subdir — sidesteps the test/*.test.ts shard re-partitioning bug
 * (#1335 retro). worktree-cmd.test.ts lives here too.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  cmdPluginInstallTier,
  fetchTierRegistry,
  filterByTier,
  isValidTier,
  DEFAULT_FROM,
  VALID_TIERS,
  type InstallTierResult,
} from "../../src/commands/plugins/plugin/install-tier-impl";

// ─── Harness ─────────────────────────────────────────────────────────────────

const created: string[] = [];
let origPluginsDir: string | undefined;
let origPluginsLock: string | undefined;
let origRegistryUrl: string | undefined;
let origFetch: typeof globalThis.fetch;

// #1308 — guard against prior shard tests leaving stderr.write monkey-patched
// against a disposed closure. Restore from a pristine pointer captured at
// import time (before any test in this file runs).
const pristineStderrWrite = process.stderr.write.bind(process.stderr);

function tmpDir(prefix = "maw-tier-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}
function pluginsDir(): string { return process.env.MAW_PLUGINS_DIR!; }

beforeEach(() => {
  if (typeof process.stderr.write !== "function") {
    (process.stderr as any).write = pristineStderrWrite;
  }
  origPluginsDir = process.env.MAW_PLUGINS_DIR;
  origPluginsLock = process.env.MAW_PLUGINS_LOCK;
  origRegistryUrl = process.env.MAW_TIER_REGISTRY_URL;
  origFetch = globalThis.fetch;

  // Per-test tmp home so ~/.maw/plugins/ writes are isolated.
  const home = tmpDir("maw-home-");
  process.env.MAW_PLUGINS_DIR = join(home, "plugins");
  process.env.MAW_PLUGINS_LOCK = join(home, "plugins.lock");
  // Ensure no stale env from a previous test forces a registry override.
  delete process.env.MAW_TIER_REGISTRY_URL;
});

afterEach(() => {
  if (origPluginsDir !== undefined) process.env.MAW_PLUGINS_DIR = origPluginsDir;
  else delete process.env.MAW_PLUGINS_DIR;
  if (origPluginsLock !== undefined) process.env.MAW_PLUGINS_LOCK = origPluginsLock;
  else delete process.env.MAW_PLUGINS_LOCK;
  if (origRegistryUrl !== undefined) process.env.MAW_TIER_REGISTRY_URL = origRegistryUrl;
  else delete process.env.MAW_TIER_REGISTRY_URL;
  // Always restore fetch — even if a test forgot to.
  globalThis.fetch = origFetch;
  for (const d of created.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

// ─── Fetch helpers ───────────────────────────────────────────────────────────

interface FakeRegistry {
  plugins: Record<string, { tier?: string; version?: string }>;
}

/**
 * Install a fetch stub that:
 *   - returns the registry JSON for any URL ending in `/registry.json`
 *   - records every URL it sees in `seen`
 *   - returns 404 for every other URL (so install attempts fail cleanly —
 *     the test asserts on what was *attempted*, not on a successful install)
 */
function installFetchStub(reg: FakeRegistry): string[] {
  const seen: string[] = [];
  const stub = async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : (url instanceof URL ? url.toString() : url.url);
    seen.push(u);
    if (u.endsWith("/registry.json")) {
      return new Response(JSON.stringify(reg), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404, statusText: "Not Found" });
  };
  (globalThis as any).fetch = stub;
  return seen;
}

/**
 * Capture console.log + console.error output produced by `fn`. Restores the
 * originals in a finally so a thrown error doesn't leak the patched console
 * to sibling tests.
 */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{
  result: T | undefined;
  error: Error | undefined;
  stdout: string;
  stderr: string;
}> {
  const origLog = console.log;
  const origErr = console.error;
  const out: string[] = [];
  const err: string[] = [];
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  let result: T | undefined;
  let error: Error | undefined;
  try { result = await fn(); }
  catch (e) { error = e as Error; }
  finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { result, error, stdout: out.join("\n"), stderr: err.join("\n") };
}

/** Plant `<pluginsDir>/<name>/plugin.json` so existsSync(...) returns true. */
function plantInstalled(name: string): string {
  const dest = join(pluginsDir(), name);
  mkdirSync(dest, { recursive: true });
  writeFileSync(
    join(dest, "plugin.json"),
    JSON.stringify({ name, version: "1.0.0", sdk: "*", entry: "./index.js" }),
  );
  return dest;
}

// ─── isValidTier ─────────────────────────────────────────────────────────────

describe("isValidTier", () => {
  test("accepts core / standard / extra", () => {
    expect(isValidTier("core")).toBe(true);
    expect(isValidTier("standard")).toBe(true);
    expect(isValidTier("extra")).toBe(true);
  });

  test("rejects unknown / empty / case-variants", () => {
    expect(isValidTier("bogus")).toBe(false);
    expect(isValidTier("")).toBe(false);
    // Case-sensitive — flag values are lowercase by convention
    expect(isValidTier("Core")).toBe(false);
    expect(isValidTier("STANDARD")).toBe(false);
  });

  test("VALID_TIERS list matches the three known tiers", () => {
    expect(VALID_TIERS).toEqual(["core", "standard", "extra"]);
  });
});

// ─── filterByTier ────────────────────────────────────────────────────────────

describe("filterByTier", () => {
  test("returns sorted names matching the tier", () => {
    const reg = {
      plugins: {
        "z-plug": { tier: "core" },
        "a-plug": { tier: "core" },
        "m-plug": { tier: "standard" },
      },
    };
    expect(filterByTier(reg, "core")).toEqual(["a-plug", "z-plug"]);
    expect(filterByTier(reg, "standard")).toEqual(["m-plug"]);
    expect(filterByTier(reg, "extra")).toEqual([]);
  });

  test("tolerates entries with missing tier field", () => {
    const reg = {
      plugins: {
        "tagged":  { tier: "core" },
        "untagged": { /* no tier */ },
      },
    };
    expect(filterByTier(reg, "core")).toEqual(["tagged"]);
  });

  test("empty registry returns empty array", () => {
    expect(filterByTier({ plugins: {} }, "core")).toEqual([]);
    // Also handles missing .plugins entirely (defensive — filterByTier uses ??)
    expect(filterByTier({}, "core")).toEqual([]);
  });
});

// ─── fetchTierRegistry ───────────────────────────────────────────────────────

describe("fetchTierRegistry", () => {
  test("builds default URL from <from> path component", async () => {
    let calledUrl = "";
    (globalThis as any).fetch = async (url: string | URL | Request) => {
      calledUrl = typeof url === "string" ? url : (url instanceof URL ? url.toString() : url.url);
      return new Response(JSON.stringify({ plugins: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await fetchTierRegistry("nat/my-mpr");
    expect(calledUrl).toBe(
      "https://raw.githubusercontent.com/nat/my-mpr/main/registry.json",
    );
  });

  test("MAW_TIER_REGISTRY_URL env var overrides the GitHub raw URL", async () => {
    let calledUrl = "";
    (globalThis as any).fetch = async (url: string | URL | Request) => {
      calledUrl = typeof url === "string" ? url : (url instanceof URL ? url.toString() : url.url);
      return new Response(JSON.stringify({ plugins: { foo: { tier: "core" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    process.env.MAW_TIER_REGISTRY_URL = "https://example.invalid/local-registry.json";
    const reg = await fetchTierRegistry("ignored/repo");
    expect(calledUrl).toBe("https://example.invalid/local-registry.json");
    expect(reg.plugins?.foo?.tier).toBe("core");
  });

  test("throws with HTTP status on non-2xx response", async () => {
    (globalThis as any).fetch = async () =>
      new Response("nope", { status: 404, statusText: "Not Found" });

    await expect(fetchTierRegistry("foo/bar")).rejects.toThrow(/HTTP 404/);
  });

  test("throws on invalid shape (missing .plugins)", async () => {
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ unrelated: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    await expect(fetchTierRegistry("foo/bar")).rejects.toThrow(/invalid registry shape/);
  });
});

// ─── cmdPluginInstallTier ────────────────────────────────────────────────────

describe("cmdPluginInstallTier", () => {
  test("--tier with zero matching plugins → graceful no-op (returns zeros)", async () => {
    installFetchStub({
      plugins: { lonely: { tier: "core" } },
    });
    // Ask for a tier that has no matches.
    const result = await cmdPluginInstallTier({ tier: "standard" });
    expect(result.total).toBe(0);
    expect(result.installed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toEqual([]);
  });

  test("already-installed plugins are skipped idempotently (no install dispatch)", async () => {
    const seen = installFetchStub({
      plugins: {
        "p1": { tier: "standard" },
        "p2": { tier: "standard" },
      },
    });
    // Plant both as already installed in the per-test pluginsDir.
    mkdirSync(pluginsDir(), { recursive: true });
    plantInstalled("p1");
    plantInstalled("p2");

    const result: InstallTierResult = await cmdPluginInstallTier({ tier: "standard" });

    expect(result.total).toBe(2);
    expect(result.installed).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.failed).toEqual([]);

    // Only the registry was fetched — no install-side fetches happened.
    const installFetches = seen.filter(u => !u.endsWith("/registry.json"));
    expect(installFetches).toEqual([]);
  });

  test("--tier core attempts only core plugins (filters out standard + extra)", async () => {
    installFetchStub({
      plugins: {
        "p-core":  { tier: "core" },
        "p-std":   { tier: "standard" },
        "p-extra": { tier: "extra" },
      },
    });
    mkdirSync(pluginsDir(), { recursive: true });
    // Nothing planted — p-core dispatch will be attempted (and fail).

    const { error, stdout } = await captureConsole(() =>
      cmdPluginInstallTier({ tier: "core" }),
    );
    // p-core's install failed (404 on github archive), so the function throws.
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/1 of 1 failed/);

    // We use the per-attempt log line (`→ <name> ← <from>/<name>`) as the
    // signal of which plugin was dispatched. URLs alone are insufficient
    // because installFromGithub fetches archive tarballs that only carry
    // <owner>/<repo>, not <subpath>.
    expect(stdout).toContain("→ p-core ← ");
    expect(stdout).not.toContain("→ p-std ← ");
    expect(stdout).not.toContain("→ p-extra ← ");
    // The "candidate(s)" summary should also list only p-core.
    expect(stdout).toMatch(/1 candidate\(s\) — p-core\b/);
  });

  test("--tier standard attempts only standard plugins (filters out core + extra)", async () => {
    installFetchStub({
      plugins: {
        "p-core":  { tier: "core" },
        "p-std":   { tier: "standard" },
        "p-extra": { tier: "extra" },
      },
    });

    const { stdout } = await captureConsole(() =>
      cmdPluginInstallTier({ tier: "standard" }),
    );
    expect(stdout).toContain("→ p-std ← ");
    expect(stdout).not.toContain("→ p-core ← ");
    expect(stdout).not.toContain("→ p-extra ← ");
  });

  test("--from <other-repo> overrides default registry repo", async () => {
    let registryUrl = "";
    (globalThis as any).fetch = async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : (url instanceof URL ? url.toString() : url.url);
      if (u.endsWith("/registry.json")) {
        registryUrl = u;
        return new Response(JSON.stringify({ plugins: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("404", { status: 404 });
    };

    await cmdPluginInstallTier({ tier: "extra", from: "nat/custom-mpr" });

    expect(registryUrl).toContain("nat/custom-mpr");
    expect(registryUrl).not.toContain(DEFAULT_FROM);
  });

  test("default --from is Soul-Brews-Studio/maw-plugin-registry", async () => {
    let registryUrl = "";
    (globalThis as any).fetch = async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : (url instanceof URL ? url.toString() : url.url);
      registryUrl = u;
      return new Response(JSON.stringify({ plugins: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await cmdPluginInstallTier({ tier: "extra" });
    expect(DEFAULT_FROM).toBe("Soul-Brews-Studio/maw-plugin-registry");
    expect(registryUrl).toContain(DEFAULT_FROM);
  });

  test("registry HTTP failure surfaces with status code and URL", async () => {
    (globalThis as any).fetch = async () =>
      new Response("oops", { status: 500, statusText: "Internal Server Error" });

    await expect(cmdPluginInstallTier({ tier: "core" })).rejects.toThrow(/HTTP 500/);
  });

  test("mixed: pre-installed + new → skipped + failed counts correctly", async () => {
    installFetchStub({
      plugins: {
        "already": { tier: "core" },
        "fresh":   { tier: "core" },
      },
    });
    mkdirSync(pluginsDir(), { recursive: true });
    plantInstalled("already");
    // 'fresh' is not planted — its install dispatch will fail (404).

    let threw: Error | undefined;
    try {
      await cmdPluginInstallTier({ tier: "core" });
    } catch (e) {
      threw = e as Error;
    }
    expect(threw).toBeDefined();
    // Summary: 0 installed, 1 skipped (already), 1 failed (fresh)
    expect(threw!.message).toMatch(/1 of 2 failed/);
  });
});

// ─── Backward compat: install-impl unchanged when --tier absent ──────────────

describe("backward compat — cmdPluginInstall surface unchanged", () => {
  test("usage error from install-impl does NOT mention --tier (still dispatched in index.ts)", async () => {
    const { cmdPluginInstall } = await import(
      "../../src/commands/plugins/plugin/install-impl"
    );
    let err: Error | undefined;
    try { await cmdPluginInstall([]); } catch (e) { err = e as Error; }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/usage:/);
    // --tier is a flag of the `plugin install` dispatcher (index.ts), not of
    // cmdPluginInstall itself. The install-impl usage line stays as-is.
    expect(err!.message).not.toMatch(/--tier/);
  });

  test("install <missing-dir> without --tier still hits old missing-source path", async () => {
    const { cmdPluginInstall } = await import(
      "../../src/commands/plugins/plugin/install-impl"
    );
    let err: Error | undefined;
    try { await cmdPluginInstall(["/nonexistent/dir/path/that/should/never/exist"]); }
    catch (e) { err = e as Error; }
    // The install-impl branch for missing local paths is unchanged — verifies
    // that wiring --tier in index.ts didn't accidentally rewire dispatch.
    expect(err).toBeDefined();
  });
});
