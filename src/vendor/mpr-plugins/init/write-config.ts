import { copyFileSync, existsSync, linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { MawConfig } from "maw-js/config/types";
import { ENGINE_SEED } from "../../../config/engine-registry";

function generateTmpPath(filePath: string): string {
  return `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
}

function writeFileAtomic(filePath: string, body: string): void {
  const tmpPath = generateTmpPath(filePath);
  try {
    writeFileSync(tmpPath, body, "utf-8");
    renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
    throw e;
  }
}

/** Atomically write JSON config; throws EEXIST if `wx` flag and file exists. */
export function writeConfigAtomic(filePath: string, config: Partial<MawConfig>, overwrite: boolean): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const body = JSON.stringify(config, null, 2) + "\n";
  if (overwrite) {
    writeFileAtomic(filePath, body);
    return;
  }

  const tmpPath = generateTmpPath(filePath);
  try {
    writeFileSync(tmpPath, body, { encoding: "utf-8", flag: "wx" });
    // Atomic no-overwrite install: hard-link fails with EEXIST if the visible
    // config path already exists, so disk-full temp writes never truncate it.
    linkSync(tmpPath, filePath);
  } catch (e) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
    throw e;
  } finally {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

export function backupConfig(filePath: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.bak.${ts}`;
  copyFileSync(filePath, backupPath);
  return backupPath;
}

export function configExists(filePath: string): boolean {
  return existsSync(filePath);
}

export interface BuildConfigInput {
  node: string;
  ghqRoot?: string;
  token?: string;
  federate?: boolean;
  peers?: { name: string; url: string }[];
  federationToken?: string;
}

const DEFAULT_PORT = 3456;
const DEFAULT_ORACLE_URL = "http://localhost:47779";

export function buildConfig(input: BuildConfigInput): Partial<MawConfig> {
  const env: Record<string, string> = {};
  if (input.token) env.CLAUDE_CODE_OAUTH_TOKEN = input.token;

  // #680 — ghqRoot is resolved on demand; only persist when caller explicitly
  // passes it (legacy override path; logs deprecation in cmdInit).
  //
  // #906 — `host` is the SSH connection target for hostExec, NOT the node
  // identity. Pre-#906 we wrote `host: input.node`, which made hostExec try
  // to `ssh <node-name> <cmd>` for every fleet-pinned clone. Concrete blast
  // radius: any user who ran `maw init --node mba` (or the prompt's default
  // os.hostname()) had `config.host = "mba"` → wake-resolve-impl's
  // `hostExec("ghq get …")` failed with `[ssh:mba] ssh: Could not resolve
  // hostname mba`. The fix is small + surgical: `host` defaults to "local"
  // (the same fallback DEFAULT_HOST uses when the field is absent), and
  // `node` keeps the identity. Existing broken configs are healed at load
  // time — see config/load.ts (#906 migration sibling).
  const cfg: Partial<MawConfig> = {
    host: "local",
    node: input.node,
    port: DEFAULT_PORT,
    oracleUrl: DEFAULT_ORACLE_URL,
    env,
    engines: { ...ENGINE_SEED },
    commands: {},
    sessions: {},
  };
  if (input.ghqRoot) cfg.ghqRoot = input.ghqRoot;

  if (input.federate) {
    cfg.federationToken = input.federationToken;
    cfg.namedPeers = input.peers ?? [];
  }

  return cfg;
}
