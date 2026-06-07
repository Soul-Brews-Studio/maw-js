/**
 * maw token save — port of token-oracle/cmd/save.py.
 *
 * Save the local .envrc to `pass` vault under `envrc/<name>`. Reads
 * .envrc as text and pipes it to `pass insert --multiline --force` via
 * stdin (never as a CLI argument — that would echo the contents into
 * `ps`).
 */

import { existsSync, readFileSync } from "fs";
import { PASS_PREFIX, confirm, defaultName, passExists, run } from "./lib";

export interface SaveOptions {
  name?: string;
  force?: boolean;
  cwd?: string;
  /** If true, skip the interactive confirm (used by tests / scripts). */
  assumeYes?: boolean;
}

export interface SaveResult {
  ok: boolean;
  path?: string;
  skipped?: boolean;
  error?: string;
}

export async function cmdSave(opts: SaveOptions = {}): Promise<SaveResult> {
  const cwd = opts.cwd ?? process.cwd();
  const name = defaultName(opts.name, cwd);
  const path = `${PASS_PREFIX}/${name}`;
  const envrcPath = `${cwd}/.envrc`;

  if (!existsSync(envrcPath)) {
    return { ok: false, error: "no .envrc in current directory" };
  }

  if (passExists(path) && !opts.force) {
    if (!opts.assumeYes) {
      const yes = await confirm(`Overwrite ${path}?`);
      if (!yes) return { ok: true, skipped: true, path };
    }
  }

  // CRITICAL: stdin, not argv. The .envrc may contain secrets.
  const content = readFileSync(envrcPath, "utf-8");
  const r = run(["pass", "insert", "--multiline", "--force", path], { stdin: content });
  if (!r.ok) {
    // Do not echo `r.stderr` / `r.stdout` raw — they may quote the
    // input on failure. Surface the exit code only.
    return { ok: false, error: `pass insert failed (exit ${r.exitCode})` };
  }

  return { ok: true, path };
}
