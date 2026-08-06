/**
 * maw token load — port of token-oracle/cmd/load.py.
 *
 * Restore an .envrc from `pass` vault and `direnv allow .`. The vault
 * entry may contain secrets — we stream `pass show` stdout straight to
 * disk without echoing it anywhere.
 */

import { existsSync, writeFileSync } from "fs";
import { PASS_PREFIX, confirm, defaultName, passExists, run } from "./lib";

export interface LoadOptions {
  name?: string;
  force?: boolean;
  cwd?: string;
  assumeYes?: boolean;
  skipDirenv?: boolean;
}

export interface LoadResult {
  ok: boolean;
  path?: string;
  skipped?: boolean;
  error?: string;
  direnvOk?: boolean;
}

export async function cmdLoad(opts: LoadOptions = {}): Promise<LoadResult> {
  const cwd = opts.cwd ?? process.cwd();
  const name = defaultName(opts.name, cwd);
  const path = `${PASS_PREFIX}/${name}`;
  const envrcPath = `${cwd}/.envrc`;

  if (!passExists(path)) {
    return { ok: false, error: `${path} not found in pass` };
  }

  if (existsSync(envrcPath) && !opts.force) {
    if (!opts.assumeYes) {
      const yes = await confirm("Overwrite .envrc?");
      if (!yes) return { ok: true, skipped: true, path };
    }
  }

  const r = run(["pass", "show", path]);
  if (!r.ok) {
    return { ok: false, error: `pass show failed (exit ${r.exitCode})` };
  }

  // SECURITY: r.stdout may contain secrets. Write straight to file —
  // do NOT log it, do NOT echo back, do NOT include in error messages.
  writeFileSync(envrcPath, r.stdout);

  let direnvOk = true;
  if (!opts.skipDirenv) {
    const d = run(["direnv", "allow", "."], { cwd });
    direnvOk = d.ok;
  }

  return { ok: true, path, direnvOk };
}
