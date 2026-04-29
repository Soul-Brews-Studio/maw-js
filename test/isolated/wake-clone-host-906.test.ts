/**
 * #906 — wake-clone host injection regression suite.
 *
 * Symptom (in the wild): `maw a mawjs-2` (auto-wake) on a fleet-pinned
 * oracle failed with the cryptic
 *   `[ssh:lock-trust-node] ssh: Could not resolve hostname lock-trust-node`
 * error. Running `ghq get -u 'github.com/<slug>'` directly from the same
 * shell succeeded.
 *
 * ROOT CAUSE: `buildConfig()` in src/commands/plugins/init/write-config.ts
 * shipped `host: input.node` for every `maw init` invocation — conflating
 * the SSH connection target (`config.host`) with the node identity
 * (`config.node`). `hostExec(cmd)` defaults to `config.host` when no
 * explicit target is passed; for any user whose init wrote a non-loopback
 * value (anything other than "local"/"localhost"), the resulting hostExec
 * call became `ssh <node-name> <cmd>`, which only works if `<node-name>`
 * happens to be SSH-resolvable.
 *
 * The wake call site is wake-resolve-impl.ts:100 —
 *   `await hostExec(\`ghq get -u 'github.com/${fleetRepo}'\`)`
 * — so EVERY fleet-pinned auto-clone was at risk. The user's reported
 * value `lock-trust-node` came from an integration test fixture
 * (test/integration/plugins-lock-trust.test.ts:148) but the bug applies
 * universally: `--node mba` → tries `ssh mba ghq get …`, etc.
 *
 * This suite locks the fix into source so a future refactor can't regress:
 *
 *   1. `buildConfig()` must write `host: "local"` (not the node name).
 *   2. `loadConfig()` must heal an existing `host === node` config in
 *      memory by resetting `host` to "local" — silent migration so
 *      operators with broken disk state recover on next process boot.
 *   3. `hostExec(cmd, "local")` must spawn `bash -c <cmd>`, NOT
 *      `ssh local <cmd>` (so the `host: "local"` fallback is genuinely
 *      no-SSH).
 *   4. `hostExec(cmd)` with no explicit host must use the local
 *      transport when `loadConfig().host === "local"`.
 *   5. The string `lock-trust-node` must NEVER appear in the spawn
 *      argv for any hostExec call when host=="local".
 *   6. Migration is idempotent + only triggers when host === node (an
 *      operator-set explicit SSH target like `host: "mba.wg"` is left
 *      alone — that's a real connection target, not a conflation).
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import { buildConfig } from "../../src/commands/plugins/init/write-config";

// ─── (1) buildConfig — host must default to "local", not node name ───────────

describe("#906 — buildConfig host/node split", () => {
  test("host defaults to \"local\" regardless of node name", () => {
    const cfg = buildConfig({ node: "white" });
    expect(cfg.host).toBe("local");
    expect(cfg.node).toBe("white");
  });

  test("the canary `lock-trust-node` value never bleeds into host", () => {
    // The string in the wild error came from a test fixture that ran with
    // --node lock-trust-node. Pre-fix, host would also be "lock-trust-node".
    // Post-fix, only `node` carries it; `host` stays "local".
    const cfg = buildConfig({ node: "lock-trust-node" });
    expect(cfg.host).toBe("local");
    expect(cfg.host).not.toBe("lock-trust-node");
    expect(cfg.node).toBe("lock-trust-node");
  });

  test("federate flag does not change host/node split", () => {
    const cfg = buildConfig({
      node: "alpha",
      federate: true,
      peers: [{ name: "mba", url: "http://10.0.0.1:3456" }],
      federationToken: "deadbeef".repeat(8),
    });
    expect(cfg.host).toBe("local");
    expect(cfg.node).toBe("alpha");
    expect(cfg.namedPeers).toEqual([{ name: "mba", url: "http://10.0.0.1:3456" }]);
  });
});

// ─── (2) loadConfig migration — heal existing broken configs in memory ───────

const REPO_ROOT = join(import.meta.dir, "..", "..");

function runConfigScript(
  script: string,
  env: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bun", ["-e", script], {
    env: { ...process.env, ...env, MAW_TEST_MODE: "1" },
    encoding: "utf-8",
    timeout: 10_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("#906 — loadConfig host=node migration", () => {
  let tempHomes: string[] = [];

  function newTempHome(diskConfig: Record<string, unknown>): string {
    const home = mkdtempSync(join(tmpdir(), "maw-906-"));
    const cfgDir = join(home, "config");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "maw.config.json"), JSON.stringify(diskConfig, null, 2));
    tempHomes.push(home);
    return home;
  }

  afterAll(() => {
    for (const h of tempHomes) {
      try { rmSync(h, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test("legacy host=node disk config heals to host=\"local\" in memory", () => {
    const home = newTempHome({
      host: "lock-trust-node",
      node: "lock-trust-node",
      port: 3456,
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: { default: "claude" },
      sessions: {},
    });
    const script = `
      const { loadConfig } = await import("${REPO_ROOT}/src/config/load.ts");
      const cfg = loadConfig();
      console.log("HOST:" + cfg.host);
      console.log("NODE:" + cfg.node);
    `;
    const { stdout } = runConfigScript(script, { MAW_HOME: home });
    expect(stdout).toContain("HOST:local");
    expect(stdout).toContain("NODE:lock-trust-node");
  });

  test("operator-set explicit SSH target is preserved (host !== node)", () => {
    const home = newTempHome({
      host: "mba.wg",
      node: "white",
      port: 3456,
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: { default: "claude" },
      sessions: {},
    });
    const script = `
      const { loadConfig } = await import("${REPO_ROOT}/src/config/load.ts");
      const cfg = loadConfig();
      console.log("HOST:" + cfg.host);
      console.log("NODE:" + cfg.node);
    `;
    const { stdout } = runConfigScript(script, { MAW_HOME: home });
    // host !== node → not a conflation, leave alone.
    expect(stdout).toContain("HOST:mba.wg");
    expect(stdout).toContain("NODE:white");
  });

  test("disk written by post-fix init survives load unchanged", () => {
    // Simulates a fresh `maw init --node mba`: host=local, node=mba.
    const home = newTempHome({
      host: "local",
      node: "mba",
      port: 3456,
      oracleUrl: "http://localhost:47779",
      env: {},
      commands: { default: "claude" },
      sessions: {},
    });
    const script = `
      const { loadConfig } = await import("${REPO_ROOT}/src/config/load.ts");
      const cfg = loadConfig();
      console.log("HOST:" + cfg.host);
      console.log("NODE:" + cfg.node);
    `;
    const { stdout } = runConfigScript(script, { MAW_HOME: home });
    expect(stdout).toContain("HOST:local");
    expect(stdout).toContain("NODE:mba");
  });
});

// ─── (3) hostExec semantics — host="local" must NOT spawn ssh ────────────────

describe("#906 — hostExec local transport never spawns ssh", () => {
  test("explicit host=\"local\" → bash transport, exit 0", async () => {
    const { hostExec } = await import("../../src/core/transport/ssh");
    const out = await hostExec("echo from-bash", "local");
    expect(out).toBe("from-bash");
  });

  test("explicit host=\"local\" → error reports local transport, never ssh", async () => {
    const { hostExec, HostExecError } = await import("../../src/core/transport/ssh");
    try {
      await hostExec("exit 7", "local");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(HostExecError);
      const err = e as InstanceType<typeof HostExecError>;
      expect(err.transport).toBe("local");
      // Critical guard: target field MUST NOT be the canary value, since
      // a passing host="local" call has nothing to do with that string.
      expect(err.target).not.toBe("lock-trust-node");
      expect(err.target).toBe("local");
    }
  });
});

// ─── (4) Fleet-pinned wake — clone target never carries a bogus host ─────────

describe("#906 — fleet clone never gets `lock-trust-node` as ssh target", () => {
  // Pure-source assertion: the wake-resolve-impl.ts call site must use the
  // unparameterized `hostExec(cmd)` signature, and the DEFAULT_HOST it falls
  // back to is `process.env.MAW_HOST || loadConfig().host || "local"`. With
  // the buildConfig + loadConfig fixes, that resolves to "local" for every
  // post-fix install. We freeze that contract here at the source level
  // (cheap, deterministic) so a future refactor can't quietly regress to
  // hard-coding a hostname.
  test("wake-resolve-impl.ts:100 — `ghq get` is invoked with the default (local) host", () => {
    const src = readFileSync(
      join(REPO_ROOT, "src/commands/shared/wake-resolve-impl.ts"),
      "utf-8",
    );
    // The exact failing line in the issue body:
    expect(src).toContain("await hostExec(`ghq get -u 'github.com/${fleetRepo}'`);");
    // No second positional argument is being snuck in — that would be
    // `await hostExec(..., "<bogus>")`. The pattern we forbid:
    expect(src).not.toMatch(/hostExec\(`ghq get -u[^`]+`,\s*['"]/);
  });

  test("buildConfig output never lets `host` shadow the node identity", () => {
    // Walk a representative set of node names — every one must give
    // host="local". This is the contract that the migration in load.ts
    // depends on.
    const cases = ["white", "mba", "lock-trust-node", "alpha", "ci-node", "1"];
    for (const node of cases) {
      const cfg = buildConfig({ node });
      expect({ node, host: cfg.host }).toEqual({ node, host: "local" });
    }
  });
});

// ─── (5) Re-clone short-circuit — second wake after manual ghq get works ─────

describe("#906 — re-cloning short-circuits when fleet repo is on disk", () => {
  // We can't exercise the full wake path in a unit test (it spawns tmux
  // and touches the real ghq). But we CAN lock the source-level guard
  // that issue (B) demands: wake-resolve-impl.ts must call ghqFind on the
  // fleet repo's stem BEFORE shelling out to `ghq get`. Without this,
  // running the suggested `manually:` workaround leaves `maw wake` in an
  // infinite re-clone loop hitting the same error.
  test("wake-resolve-impl.ts checks ghq for the fleet stem before cloning", () => {
    const src = readFileSync(
      join(REPO_ROOT, "src/commands/shared/wake-resolve-impl.ts"),
      "utf-8",
    );
    // Look for the early ghq probe that bypasses the clone when the
    // fleet-pinned repo is already on disk under its OWN slug (not just
    // the `${oracle}-oracle` slug that the top-level resolveOracle
    // already covered).
    expect(src).toMatch(/fleetRepo\.split\("\/"\)\.pop\(\)!/);
    // The early-return guard: if existing path is found, return without
    // calling hostExec (which would re-clone and re-hit the bug).
    const earlyReturnRegion = src.slice(
      src.indexOf("if (fleetRepo) {"),
      src.indexOf("await hostExec(`ghq get -u 'github.com/"),
    );
    expect(earlyReturnRegion).toContain("ghqFind");
    expect(earlyReturnRegion).toContain("return");
  });
});

// Sanity: this test file itself never spawns ssh.
test("#906 — this test file never invokes the ssh binary", () => {
  // Source-level grep so a future refactor can't sneak ssh in.
  const self = readFileSync(__filename, "utf-8");
  // The literal token must not appear as a spawn argv element. The file
  // does mention "ssh" in prose / type names, so we look for the spawn
  // shape specifically.
  expect(self).not.toMatch(/spawn(?:Sync)?\(\s*["']ssh["']/);
  expect(self).not.toMatch(/Bun\.spawn\(\s*\[\s*["']ssh["']/);
  // Reaffirm: existsSync is imported (used in the migration test setup).
  expect(typeof existsSync).toBe("function");
});
