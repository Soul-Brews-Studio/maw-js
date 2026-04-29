/**
 * #913 — host=node migration MUST persist to disk.
 *
 * #912 added an in-memory heal in `loadConfig()` that detects the
 * legacy `host === node` corruption (#906), prints a warning, and
 * resets `cached.host = "local"`. But the broken value stayed on
 * disk, so:
 *
 *   - every fresh process re-loaded the bad config,
 *   - the warning fired again every wake,
 *   - subtle module-load orderings (e.g. ssh.ts capturing
 *     `DEFAULT_HOST` from `loadConfig().host` before the migration
 *     mutation reached the import graph that needed it) could still
 *     deliver the original `[ssh:lock-trust-node]` error.
 *
 * #913 fixes this by writing the healed config back to disk inside
 * `loadConfig()`, with one exception: when MAW_TEST_MODE=1 AND the
 * resolved CONFIG_FILE equals the real homedir path, the persist is
 * skipped (mirrors the #820 saveConfig guard against test-fixture
 * leaks into developer state).
 *
 * Each scenario runs in a fresh `bun -e` subprocess so paths.ts gets
 * re-evaluated under the right env (the same pattern used by
 * #906 / #820 isolated tests).
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const REPO_ROOT = join(import.meta.dir, "..", "..");

function newTempHome(diskConfig: Record<string, unknown>, tracker: string[]): string {
  const home = mkdtempSync(join(tmpdir(), "maw-913-"));
  const cfgDir = join(home, "config");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "maw.config.json"), JSON.stringify(diskConfig, null, 2));
  tracker.push(home);
  return home;
}

function configPathFor(home: string): string {
  return join(home, "config", "maw.config.json");
}

function runScript(
  script: string,
  env: Record<string, string>,
  opts: { testMode?: boolean } = {},
): { code: number; stdout: string; stderr: string } {
  const baseEnv = { ...process.env, ...env };
  if (opts.testMode === true) baseEnv.MAW_TEST_MODE = "1";
  if (opts.testMode === false) delete baseEnv.MAW_TEST_MODE;
  const r = spawnSync("bun", ["-e", script], {
    env: baseEnv,
    encoding: "utf-8",
    timeout: 10_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const tempHomes: string[] = [];

afterAll(() => {
  for (const h of tempHomes) {
    try { rmSync(h, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const BAD_CONFIG = {
  host: "lock-trust-node",
  node: "lock-trust-node",
  port: 3456,
  oracleUrl: "http://localhost:47779",
  env: {},
  commands: { default: "claude" },
  sessions: {},
};

// ─── (1) Production path — migration writes back to disk ─────────────────────

describe("#913 — migration persists to disk in production", () => {
  test("bad config on disk → load → migration runs → disk is healed", () => {
    const home = newTempHome(BAD_CONFIG, tempHomes);
    const cfgPath = configPathFor(home);

    // Sanity: precondition is the broken value.
    const before = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(before.host).toBe("lock-trust-node");

    const script = `
      const { loadConfig } = await import("${REPO_ROOT}/src/config/load.ts");
      const cfg = loadConfig();
      console.log("HOST:" + cfg.host);
    `;
    const { stdout, stderr } = runScript(script, { MAW_HOME: home }, { testMode: false });

    expect(stdout).toContain("HOST:local");
    expect(stderr).toContain("legacy init bug (#906)");

    // Disk MUST now reflect the heal.
    const after = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(after.host).toBe("local");
    expect(after.node).toBe("lock-trust-node"); // node identity preserved
  });

  test("subsequent load → no warning (already migrated on disk)", () => {
    const home = newTempHome(BAD_CONFIG, tempHomes);

    // First load — heals + warns + persists.
    const first = runScript(
      `await import("${REPO_ROOT}/src/config/load.ts").then(m => m.loadConfig());`,
      { MAW_HOME: home },
      { testMode: false },
    );
    expect(first.stderr).toContain("legacy init bug (#906)");

    // Second load — fresh process, fresh module — disk is already healed.
    const script = `
      const { loadConfig } = await import("${REPO_ROOT}/src/config/load.ts");
      const cfg = loadConfig();
      console.log("HOST:" + cfg.host);
    `;
    const second = runScript(script, { MAW_HOME: home }, { testMode: false });

    expect(second.stdout).toContain("HOST:local");
    expect(second.stderr).not.toContain("legacy init bug (#906)");
  });

  test("preserves all other config fields when persisting", () => {
    const home = newTempHome({
      ...BAD_CONFIG,
      port: 4242,
      oracleUrl: "http://example.invalid:47779",
      env: { FOO: "bar" },
    }, tempHomes);
    const cfgPath = configPathFor(home);

    runScript(
      `await import("${REPO_ROOT}/src/config/load.ts").then(m => m.loadConfig());`,
      { MAW_HOME: home },
      { testMode: false },
    );

    const after = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(after.host).toBe("local");
    expect(after.port).toBe(4242);
    expect(after.oracleUrl).toBe("http://example.invalid:47779");
    expect(after.env).toEqual({ FOO: "bar" });
    expect(after.node).toBe("lock-trust-node");
  });
});

// ─── (2) #820 guard — refuse persist when test-mode points at real homedir ───

describe("#913 — MAW_TEST_MODE guard mirrors #820 saveConfig contract", () => {
  test("MAW_TEST_MODE=1 + sandboxed MAW_HOME → still persists (sandbox is safe)", () => {
    const home = newTempHome(BAD_CONFIG, tempHomes);
    const cfgPath = configPathFor(home);

    const script = `
      const { loadConfig } = await import("${REPO_ROOT}/src/config/load.ts");
      const cfg = loadConfig();
      console.log("HOST:" + cfg.host);
    `;
    const { stdout } = runScript(script, { MAW_HOME: home }, { testMode: true });

    expect(stdout).toContain("HOST:local");
    // Sandbox got the persist — that's what tests want to assert against.
    const after = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(after.host).toBe("local");
  });

  test("MAW_TEST_MODE=1 + CONFIG_FILE at real homedir → in-memory heal only, no disk write", () => {
    // We simulate the dangerous combo (test mode without sandbox) by
    // unsetting MAW_HOME and MAW_CONFIG_DIR. Crucially we DO NOT write
    // a bad config to the real homedir — instead we verify that the
    // guard refuses to write at all in that combination.
    const realPath = join(homedir(), ".config", "maw", "maw.config.json");
    const before = existsSync(realPath) ? readFileSync(realPath, "utf-8") : null;

    const script = `
      delete process.env.MAW_HOME;
      delete process.env.MAW_CONFIG_DIR;
      const { CONFIG_FILE } = await import("${REPO_ROOT}/src/core/paths.ts");
      // Print the resolved CONFIG_FILE so the test can sanity-check the
      // env actually pointed at the real homedir.
      console.log("CFG:" + CONFIG_FILE);
      const { loadConfig } = await import("${REPO_ROOT}/src/config/load.ts");
      try {
        const cfg = loadConfig();
        console.log("HOST:" + cfg.host);
      } catch (e) {
        // loadConfig must NOT throw — only saveConfig throws under #820.
        console.log("UNEXPECTED_THROW:" + (e instanceof Error ? e.message : String(e)));
      }
    `;
    const { stdout } = runScript(script, { MAW_HOME: "", MAW_CONFIG_DIR: "" }, { testMode: true });

    // If the real homedir does not have a host=node corruption, the
    // migration block never fires and there's no persist to skip — the
    // test still passes (no UNEXPECTED_THROW). The critical invariant
    // is defense-in-depth: even if the real config WAS corrupt, we
    // would not have written to it under test mode.
    expect(stdout).not.toContain("UNEXPECTED_THROW");
    expect(stdout).toContain("CFG:" + realPath);

    // Hard guarantee: real file must not have changed.
    const after = existsSync(realPath) ? readFileSync(realPath, "utf-8") : null;
    expect(after).toBe(before);
  });
});

// ─── (3) Negative cases — non-conflated configs are not touched ──────────────

describe("#913 — only host===node configs are persisted", () => {
  test("operator-set explicit SSH target (host !== node) → no rewrite", () => {
    const diskConfig = {
      host: "mba.wg",
      node: "white",
      port: 3456,
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: { default: "claude" },
      sessions: {},
    };
    const home = newTempHome(diskConfig, tempHomes);
    const cfgPath = configPathFor(home);
    const beforeRaw = readFileSync(cfgPath, "utf-8");

    const script = `
      const { loadConfig } = await import("${REPO_ROOT}/src/config/load.ts");
      const cfg = loadConfig();
      console.log("HOST:" + cfg.host);
    `;
    const { stdout, stderr } = runScript(script, { MAW_HOME: home }, { testMode: false });

    expect(stdout).toContain("HOST:mba.wg");
    expect(stderr).not.toContain("legacy init bug (#906)");

    // Disk untouched — no migration ran, no rewrite.
    const afterRaw = readFileSync(cfgPath, "utf-8");
    expect(afterRaw).toBe(beforeRaw);
  });

  test("post-fix init disk (host=local, node=mba) → no rewrite", () => {
    const diskConfig = {
      host: "local",
      node: "mba",
      port: 3456,
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: { default: "claude" },
      sessions: {},
    };
    const home = newTempHome(diskConfig, tempHomes);
    const cfgPath = configPathFor(home);
    const beforeRaw = readFileSync(cfgPath, "utf-8");

    runScript(
      `await import("${REPO_ROOT}/src/config/load.ts").then(m => m.loadConfig());`,
      { MAW_HOME: home },
      { testMode: false },
    );

    const afterRaw = readFileSync(cfgPath, "utf-8");
    expect(afterRaw).toBe(beforeRaw);
  });
});

// ─── (4) hostExec uses the freshly-persisted value, not stale state ──────────

describe("#913 — hostExec sees migrated host on next process boot", () => {
  test("after migration persists, ssh.ts DEFAULT_HOST resolves to \"local\"", () => {
    const home = newTempHome(BAD_CONFIG, tempHomes);

    // Step 1 — first boot heals + persists.
    runScript(
      `await import("${REPO_ROOT}/src/config/load.ts").then(m => m.loadConfig());`,
      { MAW_HOME: home },
      { testMode: false },
    );

    // Step 2 — fresh boot imports ssh.ts, which captures DEFAULT_HOST
    // at module init from `process.env.MAW_HOST || loadConfig().host`.
    // We unset MAW_HOST explicitly so the disk value is the only signal.
    const script = `
      delete process.env.MAW_HOST;
      const { hostExec } = await import("${REPO_ROOT}/src/core/transport/ssh.ts");
      // Run with no host argument — uses DEFAULT_HOST. If migration
      // persisted, DEFAULT_HOST is "local" → bash transport → echo works.
      // If migration did NOT persist, DEFAULT_HOST would still be
      // "lock-trust-node" → ssh transport → resolve failure.
      const out = await hostExec("echo from-bash");
      console.log("OUT:" + out);
    `;
    const { stdout, stderr } = runScript(
      script,
      { MAW_HOME: home },
      { testMode: false },
    );

    expect(stdout).toContain("OUT:from-bash");
    // No ssh resolve error in stderr.
    expect(stderr).not.toContain("Could not resolve hostname");
    expect(stderr).not.toContain("lock-trust-node");
  });

  test("acceptance criterion: second `maw a <oracle>` would not re-warn", () => {
    // Mirrors the issue-913 acceptance test: after one process boots
    // and heals, the file on disk has host=local, and a second process
    // boot prints no migration warning.
    const home = newTempHome(BAD_CONFIG, tempHomes);
    const cfgPath = configPathFor(home);

    const first = runScript(
      `await import("${REPO_ROOT}/src/config/load.ts").then(m => m.loadConfig());`,
      { MAW_HOME: home },
      { testMode: false },
    );
    expect(first.stderr).toContain("legacy init bug (#906)");

    // Disk acceptance check from the issue body.
    const persisted = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(persisted.host).toBe("local");

    // Second boot is silent.
    const second = runScript(
      `await import("${REPO_ROOT}/src/config/load.ts").then(m => m.loadConfig());`,
      { MAW_HOME: home },
      { testMode: false },
    );
    expect(second.stderr).not.toContain("legacy init bug (#906)");
  });
});

// ─── (5) Source-level guard — the persist branch lives inside loadConfig ─────

test("#913 — load.ts contains a writeFileSync inside the host=node migration block", () => {
  const src = readFileSync(join(REPO_ROOT, "src/config/load.ts"), "utf-8");
  // The fix must call writeFileSync after setting cached.host = "local"
  // in the host=node branch. We check the structural pattern rather
  // than exact whitespace so a future refactor can rearrange comments.
  expect(src).toMatch(/cached\.host = "local";[\s\S]*writeFileSync\(CONFIG_FILE/);
  // The #820-style guard must wrap the persist.
  expect(src).toMatch(/MAW_TEST_MODE.*REAL_HOME_CONFIG/);
});
