/**
 * maw oracle {set,get}-nickname — Phase 1 of #643.
 *
 * set-nickname writes the authoritative on-disk file first, then refreshes the
 * read-through cache. Empty string is an explicit clear.
 * get-nickname reads cache → on-disk fallback → null.
 */

import { readCache, type OracleEntry } from "../../../sdk";
import {
  setCachedNickname,
  validateNickname,
  writeNickname,
  resolveNickname,
} from "../../../core/fleet/nicknames";

export interface NicknameOpts {
  json?: boolean;
}

function findEntry(name: string): OracleEntry | null {
  const cache = readCache();
  if (!cache) return null;
  return cache.oracles.find((e) => e.name === name) ?? null;
}

export function cmdOracleSetNickname(
  name: string,
  nickname: string,
  opts: NicknameOpts = {},
): void {
  if (!name) throw new Error("usage: maw oracle set-nickname <oracle> \"<nickname>\"");

  const entry = findEntry(name);
  if (!entry) {
    throw new Error(
      `oracle '${name}' not found in registry — try: maw oracle scan`,
    );
  }
  if (!entry.local_path) {
    throw new Error(
      `oracle '${name}' has no local path (not cloned) — clone it before setting a nickname`,
    );
  }

  const v = validateNickname(nickname);
  if (!v.ok) throw new Error(v.error);

  // on-disk first (authoritative), then cache
  writeNickname(entry.local_path, v.value);
  setCachedNickname(name, v.value);

  if (opts.json) {
    console.log(
      JSON.stringify(
        { schema: 1, name, nickname: v.value === "" ? null : v.value, cleared: v.value === "" },
        null,
        2,
      ),
    );
    return;
  }

  if (v.value === "") {
    console.log(`  \x1b[32m✓\x1b[0m cleared nickname for \x1b[36m${name}\x1b[0m`);
  } else {
    console.log(
      `  \x1b[32m✓\x1b[0m \x1b[36m${name}\x1b[0m nickname set to \x1b[33m${v.value}\x1b[0m`,
    );
  }
}

export function cmdOracleGetNickname(
  name: string,
  opts: NicknameOpts = {},
): void {
  if (!name) throw new Error("usage: maw oracle get-nickname <oracle>");

  const entry = findEntry(name);
  const repoPath = entry?.local_path || null;
  const value = resolveNickname(name, repoPath);

  if (opts.json) {
    console.log(JSON.stringify({ schema: 1, name, nickname: value }, null, 2));
    return;
  }

  if (value === null) {
    console.error(`  \x1b[90mno nickname set for ${name}\x1b[0m`);
    process.exitCode = 1;
    return;
  }
  console.log(value);
}
