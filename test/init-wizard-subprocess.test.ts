/**
 * init-wizard-subprocess.test.ts — subprocess tests for `maw init --non-interactive` (#455).
 *
 * Strategy: spawn the real CLI via `bun run src/cli.ts init ...`, isolated by:
 *   - HOME=<tmpdir> → redirects plugin-bootstrap to a scratch ~/.maw/plugins
 *   - MAW_CONFIG_DIR=<tmpdir>/config → redirects CONFIG_FILE writes
 * No mocks. No direct imports of the wizard handler. Integration coverage only.
 *
 * Paired with test/isolated/init-wizard.test.ts (wizard-impl's in-process unit
 * tests). This file covers the CLI surface end-to-end — what a user actually
 * invokes — via real subprocesses, per spec § 4c.
 *
 * Each test mkdtemps its own HOME and MAW_CONFIG_DIR, so cases don't leak.
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import {
  mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync, chmodSync,
} from "fs";
import { tmpdir, homedir } from "os";
import { join, dirname } from "path";

// ─── Test harness ────────────────────────────────────────────────────────────

const REPO_ROOT = join(import.meta.dir, "..");
const CLI_PATH = join(REPO_ROOT, "src", "cli.ts");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  configPath: string;
  configDir: string;
  homeDir: string;
}

function runInit(args: string[], extraEnv: Record<string, string> = {}): RunResult {
  const homeDir = mkdtempSync(join(tmpdir(), "maw-init-home-"));
  const configDir = join(homeDir, "config", "maw");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(homeDir, ".maw", "plugins"), { recursive: true });

  const result = spawnSync("bun", ["run", CLI_PATH, "init", ...args], {
    env: {
      ...process.env,
      HOME: homeDir,
      MAW_CONFIG_DIR: configDir,
      MAW_CLI: "1",
      ...extraEnv,
    },
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 10_000,
  });

  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    configPath: join(configDir, "maw.config.json"),
    configDir,
    homeDir,
  };
}

function readConfig(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

// ─── Happy path ──────────────────────────────────────────────────────────────

describe("maw init --non-interactive — happy path", () => {
  test("writes config with --node and --ghq-root", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit(["--non-interactive", "--node", "alpha", "--ghq-root", ghq]);
    expect(r.code).toBe(0);
    expect(existsSync(r.configPath)).toBe(true);

    const cfg = readConfig(r.configPath);
    // #906 — host = SSH connection target (defaults to "local"); node = identity.
    expect(cfg.host).toBe("local");
    expect(cfg.node).toBe("alpha");
    expect(cfg.ghqRoot).toBe(ghq);
  });

  test("fills in default port, oracleUrl, commands.default", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit(["--non-interactive", "--node", "alpha", "--ghq-root", ghq]);
    expect(r.code).toBe(0);

    const cfg = readConfig(r.configPath);
    expect(cfg.port).toBe(3456);
    expect(cfg.oracleUrl).toBe("http://localhost:47779");
    expect(cfg.commands).toBeTruthy();
    expect(typeof cfg.commands.default).toBe("string");
    expect(cfg.commands.default.length).toBeGreaterThan(0);
  });

  test("writes sessions as {} (empty object, not undefined)", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit(["--non-interactive", "--node", "alpha", "--ghq-root", ghq]);
    expect(r.code).toBe(0);

    const cfg = readConfig(r.configPath);
    expect(cfg.sessions).toEqual({});
  });
});

// ─── Q1 — node name validation ───────────────────────────────────────────────

describe("maw init — node name validation (Q1)", () => {
  test("node name with spaces → exit != 0, error mentions allowed charset", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit(["--non-interactive", "--node", "my oracle", "--ghq-root", ghq]);
    expect(r.code).not.toBe(0);
    const combined = (r.stderr + r.stdout).toLowerCase();
    // spec error: "Node name must be 1-63 chars, letters/digits/hyphens only"
    expect(combined).toMatch(/letters.*digits.*hyphens|hyphens.*only|1-63/);
  });

  test("64-char node name → reject (max 63)", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const longName = "a".repeat(64);
    const r = runInit(["--non-interactive", "--node", longName, "--ghq-root", ghq]);
    expect(r.code).not.toBe(0);
    expect(existsSync(r.configPath)).toBe(false);
  });

  test("63-char node name → accept (boundary)", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const name = "a".repeat(63);
    const r = runInit(["--non-interactive", "--node", name, "--ghq-root", ghq]);
    expect(r.code).toBe(0);
    // #906 — assert against `node`, not `host`. host stays "local".
    expect(readConfig(r.configPath).node).toBe(name);
  });

  test("node name starting with hyphen → reject", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit(["--non-interactive", "--node", "-alpha", "--ghq-root", ghq]);
    expect(r.code).not.toBe(0);
  });

  test("single-char node name '1' → accept", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit(["--non-interactive", "--node", "1", "--ghq-root", ghq]);
    expect(r.code).toBe(0);
    // #906 — assert against `node`, not `host`. host stays "local".
    expect(readConfig(r.configPath).node).toBe("1");
  });

  test("node name with underscore → reject (hostname-safe regex excludes _)", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit(["--non-interactive", "--node", "a_b", "--ghq-root", ghq]);
    expect(r.code).not.toBe(0);
  });
});

// ─── Q2 — ghqRoot validation ─────────────────────────────────────────────────

describe("maw init — ghqRoot validation (Q2)", () => {
  test("relative path → reject with 'absolute' error", () => {
    const r = runInit(["--non-interactive", "--node", "alpha", "--ghq-root", "Code/github.com"]);
    expect(r.code).not.toBe(0);
    const combined = (r.stderr + r.stdout).toLowerCase();
    expect(combined).toMatch(/absolute/);
  });

  test("existing directory → accept", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit(["--non-interactive", "--node", "alpha", "--ghq-root", ghq]);
    expect(r.code).toBe(0);
    expect(readConfig(r.configPath).ghqRoot).toBe(ghq);
  });

  test("non-existing path with writable parent → accept", () => {
    const parent = mkdtempSync(join(tmpdir(), "maw-init-parent-"));
    const ghq = join(parent, "does-not-exist-yet");
    expect(existsSync(ghq)).toBe(false);
    const r = runInit(["--non-interactive", "--node", "alpha", "--ghq-root", ghq]);
    expect(r.code).toBe(0);
    expect(readConfig(r.configPath).ghqRoot).toBe(ghq);
  });

  // #510 (partial): wizard accepts unwritable parent — writability is
  // better checked at runtime clone step (avoids false-rejects when tests use
  // paths like /home/nat/Code that don't exist on the runner). Re-skipped.
  test.skip("non-existing path with unwritable parent → reject", () => {
    const parent = mkdtempSync(join(tmpdir(), "maw-init-ro-"));
    chmodSync(parent, 0o555);
    try {
      const ghq = join(parent, "cant-create-here");
      const r = runInit(["--non-interactive", "--node", "alpha", "--ghq-root", ghq]);
      expect(r.code).not.toBe(0);
      const combined = (r.stderr + r.stdout).toLowerCase();
      expect(combined).toMatch(/permission|cannot create|not writable|writ/);
    } finally {
      chmodSync(parent, 0o755);
    }
  });
});

// ─── Q3 — token handling ─────────────────────────────────────────────────────

describe("maw init — Claude token (Q3)", () => {
  // #510: wizard emits a stderr warning when no --token AND no env var (spec § 3 Q3).
  test("no --token and no env var → success with warning in stderr", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit(
      ["--non-interactive", "--node", "alpha", "--ghq-root", ghq],
      { CLAUDE_CODE_OAUTH_TOKEN: "" },
    );
    expect(r.code).toBe(0);
    const combined = r.stderr + r.stdout;
    expect(combined.toLowerCase()).toMatch(/token|credential|claude/);

    const cfg = readConfig(r.configPath);
    // env block may be absent, empty, or lack the key — all are OK here.
    const tok = cfg.env?.CLAUDE_CODE_OAUTH_TOKEN;
    expect(tok === undefined || tok === "").toBe(true);
  });

  test("--token foo → written to env.CLAUDE_CODE_OAUTH_TOKEN", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit([
      "--non-interactive", "--node", "alpha", "--ghq-root", ghq,
      "--token", "sk-ant-test-0123456789",
    ]);
    expect(r.code).toBe(0);
    const cfg = readConfig(r.configPath);
    expect(cfg.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-test-0123456789");
  });
});

// ─── Q4 — federation ─────────────────────────────────────────────────────────

describe("maw init — federation (Q4)", () => {
  test("--federate + single peer → writes namedPeers and federationToken", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit([
      "--non-interactive", "--node", "alpha", "--ghq-root", ghq,
      "--federate", "--peer", "http://192.168.1.10:3456", "--peer-name", "white",
    ]);
    expect(r.code).toBe(0);

    const cfg = readConfig(r.configPath);
    expect(cfg.namedPeers).toEqual([{ name: "white", url: "http://192.168.1.10:3456" }]);
    expect(typeof cfg.federationToken).toBe("string");
    expect(cfg.federationToken.length).toBeGreaterThanOrEqual(16);
    expect(cfg.federationToken).toMatch(/^[a-f0-9]+$/);
  });

  test("federationToken is hex-only and ≥ 16 chars", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit([
      "--non-interactive", "--node", "alpha", "--ghq-root", ghq,
      "--federate", "--peer", "http://x.example:3456", "--peer-name", "x",
    ]);
    expect(r.code).toBe(0);
    const tok = readConfig(r.configPath).federationToken;
    expect(tok).toMatch(/^[a-f0-9]{16,}$/);
  });

  test("peer URL without protocol → reject", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit([
      "--non-interactive", "--node", "alpha", "--ghq-root", ghq,
      "--federate", "--peer", "192.168.1.10:3456", "--peer-name", "bad",
    ]);
    expect(r.code).not.toBe(0);
    const combined = (r.stderr + r.stdout).toLowerCase();
    expect(combined).toMatch(/http|protocol|url/);
  });

  test("peer URL with ftp:// → reject", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit([
      "--non-interactive", "--node", "alpha", "--ghq-root", ghq,
      "--federate", "--peer", "ftp://example.com", "--peer-name", "bad",
    ]);
    expect(r.code).not.toBe(0);
  });

  test("multiple --peer entries → all captured in namedPeers", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit([
      "--non-interactive", "--node", "alpha", "--ghq-root", ghq,
      "--federate",
      "--peer", "http://10.0.0.1:3456", "--peer-name", "a",
      "--peer", "http://10.0.0.2:3456", "--peer-name", "b",
      "--peer", "https://c.example.com:3456", "--peer-name", "c",
    ]);
    expect(r.code).toBe(0);

    const cfg = readConfig(r.configPath);
    expect(Array.isArray(cfg.namedPeers)).toBe(true);
    expect(cfg.namedPeers).toHaveLength(3);
    const names = cfg.namedPeers.map((p: any) => p.name).sort();
    expect(names).toEqual(["a", "b", "c"]);
  });

  test("--federate with no --peer → empty namedPeers, token still generated", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit([
      "--non-interactive", "--node", "alpha", "--ghq-root", ghq,
      "--federate",
    ]);
    expect(r.code).toBe(0);
    const cfg = readConfig(r.configPath);
    expect(cfg.namedPeers ?? []).toEqual([]);
    expect(typeof cfg.federationToken).toBe("string");
    expect(cfg.federationToken.length).toBeGreaterThanOrEqual(16);
  });
});

// ─── Edge case: existing config (spec § 4a) ──────────────────────────────────

describe("maw init — existing config handling (§ 4a)", () => {
  function seedExistingConfig(configPath: string, content: any = { host: "preexisting", port: 9999 }): void {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(content, null, 2));
  }

  test("without --force → exit 1, file unchanged", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    // First run creates the config.
    const first = runInit(["--non-interactive", "--node", "first", "--ghq-root", ghq]);
    expect(first.code).toBe(0);
    const before = readFileSync(first.configPath, "utf-8");

    // Second run into the SAME home/config dir (re-use env).
    const second = spawnSync(
      "bun",
      ["run", CLI_PATH, "init", "--non-interactive", "--node", "second", "--ghq-root", ghq],
      {
        env: { ...process.env, HOME: first.homeDir, MAW_CONFIG_DIR: first.configDir, MAW_CLI: "1" },
        cwd: REPO_ROOT,
        encoding: "utf-8",
        timeout: 10_000,
      },
    );
    expect(second.status ?? -1).not.toBe(0);
    const combined = ((second.stderr ?? "") + (second.stdout ?? "")).toLowerCase();
    expect(combined).toMatch(/exist|already|--force/);

    const after = readFileSync(first.configPath, "utf-8");
    expect(after).toBe(before);
  });

  test("with --force → overwrite in place", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const first = runInit(["--non-interactive", "--node", "first", "--ghq-root", ghq]);
    expect(first.code).toBe(0);

    const second = spawnSync(
      "bun",
      ["run", CLI_PATH, "init",
        "--non-interactive", "--node", "second", "--ghq-root", ghq, "--force"],
      {
        env: { ...process.env, HOME: first.homeDir, MAW_CONFIG_DIR: first.configDir, MAW_CLI: "1" },
        cwd: REPO_ROOT,
        encoding: "utf-8",
        timeout: 10_000,
      },
    );
    expect(second.status ?? -1).toBe(0);

    const cfg = readConfig(first.configPath);
    // #906 — assert against `node`. host stays "local" by design.
    expect(cfg.node).toBe("second");
  });

  // #510: --backup flag supported in --non-interactive (spec § 4a).
  test("with --backup → backup file with .bak.<timestamp> suffix, overwrite", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const first = runInit(["--non-interactive", "--node", "first", "--ghq-root", ghq]);
    expect(first.code).toBe(0);
    const originalContent = readFileSync(first.configPath, "utf-8");

    const second = spawnSync(
      "bun",
      ["run", CLI_PATH, "init",
        "--non-interactive", "--node", "second", "--ghq-root", ghq, "--backup"],
      {
        env: { ...process.env, HOME: first.homeDir, MAW_CONFIG_DIR: first.configDir, MAW_CLI: "1" },
        cwd: REPO_ROOT,
        encoding: "utf-8",
        timeout: 10_000,
      },
    );
    expect(second.status ?? -1).toBe(0);

    // New config reflects second run
    // #906 — assert against `node`. host stays "local" by design.
    expect(readConfig(first.configPath).node).toBe("second");

    // Some file in the config dir should match the backup pattern
    const entries = readdirSync(first.configDir);
    const backups = entries.filter((f) => /^maw\.config\.json\.bak\./.test(f));
    expect(backups.length).toBeGreaterThanOrEqual(1);

    // Backup contents must equal the original pre-overwrite file
    const backupContent = readFileSync(join(first.configDir, backups[0]), "utf-8");
    expect(backupContent).toBe(originalContent);
  });
});

// ─── Edge case: missing required flags in --non-interactive ──────────────────

describe("maw init --non-interactive — missing required flags", () => {
  test("no --node → either detected default OR exit 1 with usage hint", () => {
    // Spec is ambiguous: --node defaults to os.hostname() in spec § 4c flag
    // table, but § 4c rules say "Missing required config: exits 1". We accept
    // either behavior — just pin down what wizard-impl chose.
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit(["--non-interactive", "--ghq-root", ghq]);
    if (r.code === 0) {
      const cfg = readConfig(r.configPath);
      expect(typeof cfg.host).toBe("string");
      expect(cfg.host.length).toBeGreaterThan(0);
    } else {
      const combined = (r.stderr + r.stdout).toLowerCase();
      expect(combined).toMatch(/--node|node name|usage|required/);
    }
  });

  test("no --ghq-root → exit 0 (resolved on demand via ghq root, #680) OR exit 1 with usage hint", () => {
    const r = runInit(["--non-interactive", "--node", "alpha"]);
    if (r.code === 0) {
      // #680 — ghqRoot no longer persisted by default; getGhqRoot() resolves it on demand.
      // Either behaviour is acceptable: config may or may not include ghqRoot.
      const cfg = readConfig(r.configPath);
      if (cfg.ghqRoot !== undefined) {
        expect(typeof cfg.ghqRoot).toBe("string");
        expect(cfg.ghqRoot.length).toBeGreaterThan(0);
      }
    } else {
      const combined = (r.stderr + r.stdout).toLowerCase();
      expect(combined).toMatch(/--ghq-root|ghq|usage|required/);
    }
  });
});

// ─── Smoke: the init command exists at all ───────────────────────────────────

describe("maw init — plumbing", () => {
  test("command is registered (not 'unknown command')", () => {
    // Even if the wizard errors for some other reason, it must NOT report
    // "unknown command: init". That error signals the plugin was never wired.
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit(["--non-interactive", "--node", "alpha", "--ghq-root", ghq]);
    expect(r.stderr).not.toMatch(/unknown command:\s*init/i);
  });

  test("does not hang — completes within subprocess timeout", () => {
    const ghq = mkdtempSync(join(tmpdir(), "maw-init-ghq-"));
    const r = runInit(["--non-interactive", "--node", "alpha", "--ghq-root", ghq]);
    // If spawnSync had timed out, status would be null → code === -1.
    expect(r.code).not.toBe(-1);
  });
});
