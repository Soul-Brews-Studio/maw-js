/**
 * maw trust — storage layer (#842 Sub-B).
 *
 * Atomic read/write of `<CONFIG_DIR>/trust.json`. Holds the pairwise
 * trust list consulted by `evaluateAcl()` (Sub-A, #872) when neither
 * sender nor target share a scope. Trust is symmetric: an entry
 * `{sender: a, target: b}` allows BOTH directions a→b and b→a.
 *
 * Schema v1 — flat array of TrustEntry. We deliberately avoid the
 * peers-style `{version, peers: {alias: {...}}}` map because trust
 * entries are pair-keyed, not alias-keyed; a flat array with dedup on
 * write is simpler and matches the `TrustList` shape exposed by
 * `scope-acl.ts`.
 *
 *   [
 *     { "sender": "alpha", "target": "beta", "addedAt": "2026-04-28T..." },
 *     ...
 *   ]
 *
 * Path resolution mirrors `scope/impl.ts::scopesDir()` — a function
 * (not a const) so tests setting `MAW_CONFIG_DIR` / `MAW_HOME` per-test
 * pick up a fresh path each call.
 *
 * Atomic writes via tmp + rename(2) — same trick as
 * `src/commands/plugins/peers/store.ts::writeAtomic`. A crash mid-write
 * leaves either the old file intact or the new file fully in place,
 * never a truncated file. No file lock yet — Phase 1 is operator-driven
 * and `maw trust add` is rare enough that racing writers aren't a
 * realistic workload (mirrors scope's Phase 1 decision).
 *
 * Forgiving load semantics — missing file, corrupt JSON, or wrong
 * shape all fall back to `[]` rather than throwing. The ACL evaluator
 * treating "no trust file" the same as "empty trust list" means an
 * operator who's never run `maw trust add` still gets a working ACL.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

/**
 * On-disk trust entry. `sender` / `target` are oracle names matching
 * `Scope.members[*]`. `addedAt` is the ISO timestamp when the entry was
 * first written — useful for `maw trust list` to show recency, and for
 * future TTL semantics if/when trust entries gain expiry.
 *
 * Mirrors {@link import("../../shared/scope-acl").TrustEntry} on the
 * pair-key fields, with `addedAt` added on disk. `evaluateAcl()` only
 * reads `sender` / `target`, so the extra field doesn't break the ACL
 * type contract (TypeScript structural typing — extra fields are fine).
 */
export interface TrustEntryOnDisk {
  sender: string;
  target: string;
  addedAt: string;
}

/** A flat list of on-disk trust entries. May be empty. */
export type TrustListOnDisk = TrustEntryOnDisk[];

/**
 * Resolve the active config dir at call time (not import time) so tests
 * can point the directory at a temp path per-test by setting
 * `MAW_CONFIG_DIR` / `MAW_HOME` in beforeEach. Mirrors the precedence
 * logic in `src/core/paths.ts` and `scope/impl.ts::activeConfigDir`.
 *
 *   1. `MAW_HOME` → `<MAW_HOME>/config` (instance mode, see #566)
 *   2. `MAW_CONFIG_DIR` override (legacy)
 *   3. Default singleton `~/.config/maw/`
 */
function activeConfigDir(): string {
  if (process.env.MAW_HOME) return join(process.env.MAW_HOME, "config");
  if (process.env.MAW_CONFIG_DIR) return process.env.MAW_CONFIG_DIR;
  return join(homedir(), ".config", "maw");
}

export function trustPath(): string {
  return join(activeConfigDir(), "trust.json");
}

/**
 * Read the trust list from disk. Returns `[]` if the file is missing,
 * unreadable, or malformed — forgiving semantics so an operator who's
 * never written a trust entry still gets a working empty list.
 */
export function loadTrust(): TrustListOnDisk {
  const path = trustPath();
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: skip entries that don't have the required string fields.
    // Operators may hand-edit trust.json (parallel to scope JSON's
    // documented hand-edit workflow), so a typo'd line shouldn't sink
    // the whole list.
    return parsed.filter(
      (e: any): e is TrustEntryOnDisk =>
        e &&
        typeof e.sender === "string" &&
        typeof e.target === "string" &&
        typeof e.addedAt === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Write the trust list atomically (tmp + rename). Creates the config
 * directory if missing. Mirrors `peers/store.ts::writeAtomic`.
 */
export function saveTrust(list: TrustListOnDisk): void {
  const path = trustPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * Symmetric pair equality. `{a, b}` matches `{b, a}` — trust is
 * direction-agnostic, same as `evaluateAcl()`'s match semantics.
 */
export function samePair(
  a: { sender: string; target: string },
  b: { sender: string; target: string },
): boolean {
  return (
    (a.sender === b.sender && a.target === b.target) ||
    (a.sender === b.target && a.target === b.sender)
  );
}
