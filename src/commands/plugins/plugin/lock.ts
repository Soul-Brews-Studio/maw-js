/**
 * plugins.lock — registry-pinned plugin hashes (#487, Option A).
 *
 * A node-local JSON file (~/.maw/plugins.lock) that maps plugin names to
 * approved {version, sha256, source} entries. `maw plugin install` derives
 * the expected hash from here instead of from the tarball's own manifest,
 * closing the circular-trust bug where an attacker who controls the tarball
 * controls both the artifact AND its declared hash.
 *
 * See ψ/writing/2026-04-18/plugin-hash-supply-chain-spec.md for the spec.
 */

import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { hashFile } from "../../../plugin/registry";
import { readManifest } from "./install-manifest-helpers";
import { extractTarball } from "./install-extraction";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

export const LOCK_SCHEMA = 1;

export interface LockEntry {
  version: string;
  sha256: string;
  source: string;
  added: string;
  signers?: string[];
}

export interface Lock {
  schema: number;
  updated: string;
  plugins: Record<string, LockEntry>;
}

/** Default lock when none exists on disk. */
function emptyLock(): Lock {
  return { schema: LOCK_SCHEMA, updated: new Date().toISOString(), plugins: {} };
}

/** Resolve lock path. Honors MAW_PLUGINS_LOCK for tests. */
export function lockPath(): string {
  return process.env.MAW_PLUGINS_LOCK || join(homedir(), ".maw", "plugins.lock");
}

/** Validate sha256 is a canonical "sha256:" + 64 lowercase hex, or bare 64-hex. */
export function validateSha256(value: string): { ok: true } | { ok: false; error: string } {
  const s = typeof value === "string" ? value : "";
  const hex = s.startsWith("sha256:") ? s.slice("sha256:".length) : s;
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    return { ok: false, error: `invalid sha256 (want 64 lowercase hex chars, got ${JSON.stringify(s)})` };
  }
  return { ok: true };
}

/** Plugin names: segmented by '/', lowercase alnum + . _ - within segments. */
export function validateName(name: string): { ok: true } | { ok: false; error: string } {
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, error: "plugin name required" };
  }
  if (!/^[a-z0-9][a-z0-9._\-\/]{0,127}$/.test(name)) {
    return { ok: false, error: `invalid plugin name ${JSON.stringify(name)}` };
  }
  return { ok: true };
}

/** Schema check — refuse unknown schema versions with migration hint. */
export function validateSchema(parsed: unknown): { ok: true; lock: Lock } | { ok: false; error: string } {
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "plugins.lock: not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  const schema = obj.schema ?? obj["$schema"];
  if (typeof schema !== "number") {
    return { ok: false, error: "plugins.lock: missing numeric 'schema' field" };
  }
  if (schema !== LOCK_SCHEMA) {
    return {
      ok: false,
      error:
        `plugins.lock: unknown schema ${schema} (this build supports ${LOCK_SCHEMA}).\n` +
        `  migration: upgrade maw-js or regenerate the lockfile with 'maw plugin pin' on each entry.`,
    };
  }
  const plugins = obj.plugins;
  if (plugins === undefined || typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) {
    return { ok: false, error: "plugins.lock: 'plugins' must be an object" };
  }
  const updated = typeof obj.updated === "string" ? obj.updated : new Date().toISOString();
  // Per-entry validation.
  const out: Record<string, LockEntry> = {};
  for (const [name, entry] of Object.entries(plugins as Record<string, unknown>)) {
    const nv = validateName(name);
    if (!nv.ok) return { ok: false, error: `plugins.lock: ${nv.error}` };
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: `plugins.lock: entry '${name}' is not an object` };
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.version !== "string" || !e.version) {
      return { ok: false, error: `plugins.lock: entry '${name}' missing 'version'` };
    }
    if (typeof e.sha256 !== "string") {
      return { ok: false, error: `plugins.lock: entry '${name}' missing 'sha256'` };
    }
    const hv = validateSha256(e.sha256);
    if (!hv.ok) return { ok: false, error: `plugins.lock: entry '${name}': ${hv.error}` };
    if (typeof e.source !== "string") {
      return { ok: false, error: `plugins.lock: entry '${name}' missing 'source'` };
    }
    out[name] = {
      version: e.version,
      sha256: e.sha256,
      source: e.source,
      added: typeof e.added === "string" ? e.added : updated,
      signers: Array.isArray(e.signers) ? (e.signers as string[]).filter(s => typeof s === "string") : undefined,
    };
  }
  return { ok: true, lock: { schema: LOCK_SCHEMA, updated, plugins: out } };
}

/** Warn to stderr if lockfile is world-writable. Per spec §8: warn but proceed. */
function checkLockPermissions(path: string): void {
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o022) !== 0) {
      process.stderr.write(
        `\x1b[33m!\x1b[0m plugins.lock is group/world-writable (mode ${mode.toString(8)}) — ` +
        `recommend 'chmod 0644 ${path}'\n`
      );
    }
  } catch { /* stat can fail on exotic filesystems — non-fatal */ }
}

/**
 * Read + validate the lockfile. Returns an empty lock if the file does not
 * exist (first-time use). Throws on malformed JSON or unknown schema so the
 * caller never silently treats a broken lock as "no plugins pinned".
 */
export function readLock(): Lock {
  const path = lockPath();
  if (!existsSync(path)) return emptyLock();
  checkLockPermissions(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e: any) {
    throw new Error(`plugins.lock: invalid JSON at ${path}: ${e.message}`);
  }
  const v = validateSchema(parsed);
  if (!v.ok) throw new Error(v.error);
  return v.lock;
}

/**
 * Atomically write the lockfile. Writes to <path>.tmp then renames into place
 * so a crashed write never leaves a half-written lock on disk.
 */
export function writeLock(lock: Lock): void {
  const path = lockPath();
  const tmp = `${path}.tmp`;
  const content = JSON.stringify({ ...lock, updated: new Date().toISOString() }, null, 2) + "\n";
  // Exclusive create on the tmp path — if a prior write crashed and left
  // <path>.tmp behind, we refuse to clobber without surfacing it.
  try {
    writeFileSync(tmp, content, { encoding: "utf8", flag: "w" });
  } catch (e: any) {
    throw new Error(`plugins.lock: failed to stage ${tmp}: ${e.message}`);
  }
  try {
    chmodSync(tmp, 0o644);
  } catch { /* not all filesystems support chmod — continue */ }
  renameSync(tmp, path);
}

/** Compute sha256 of a tarball's declared artifact (matches manifest.artifact.path). */
function hashTarballArtifact(tarballPath: string): { ok: true; hash: string; version: string } | { ok: false; error: string } {
  if (!existsSync(tarballPath)) {
    return { ok: false, error: `source not found: ${tarballPath}` };
  }
  const staging = mkdtempSync(join(tmpdir(), "maw-pin-"));
  try {
    const ex = extractTarball(tarballPath, staging);
    if (!ex.ok) return { ok: false, error: ex.error };
    const manifest = readManifest(staging);
    if (!manifest) return { ok: false, error: "failed to read plugin.json from tarball" };
    if (!manifest.artifact) {
      return { ok: false, error: "tarball manifest has no 'artifact' field — rebuild with 'maw plugin build'" };
    }
    const artifactPath = join(staging, manifest.artifact.path);
    if (!existsSync(artifactPath)) {
      return { ok: false, error: `artifact missing at ${manifest.artifact.path}` };
    }
    const hash = hashFile(artifactPath);
    return { ok: true, hash, version: manifest.version };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export interface PinOptions {
  version?: string;
  signers?: string[];
}

export interface PinResult {
  name: string;
  entry: LockEntry;
  previous?: LockEntry;
}

/**
 * Pin a plugin: hash the tarball at `source`, stage a lockfile entry, write.
 * Source must be a local tarball path for v1 (URL pinning needs download +
 * cache; deferred to follow-up — document in pin command help).
 */
export function pinPlugin(name: string, source: string, opts: PinOptions = {}): PinResult {
  const nv = validateName(name);
  if (!nv.ok) throw new Error(nv.error);

  const h = hashTarballArtifact(source);
  if (!h.ok) throw new Error(h.error);

  if (opts.version !== undefined && opts.version !== h.version) {
    throw new Error(
      `version mismatch: --version=${opts.version} but tarball manifest.version=${h.version}`,
    );
  }

  const lock = readLock();
  const previous = lock.plugins[name];
  const now = new Date().toISOString();
  const entry: LockEntry = {
    version: h.version,
    sha256: h.hash,
    source,
    added: previous?.added ?? now,
    ...(opts.signers && opts.signers.length ? { signers: opts.signers } : {}),
  };
  lock.plugins[name] = entry;
  writeLock(lock);
  return { name, entry, previous };
}

export interface UnpinResult {
  name: string;
  removed: LockEntry | null;
}

/** Remove a plugin from the lockfile. No-op if not present. */
export function unpinPlugin(name: string): UnpinResult {
  const nv = validateName(name);
  if (!nv.ok) throw new Error(nv.error);
  const lock = readLock();
  const removed = lock.plugins[name] ?? null;
  if (removed) {
    delete lock.plugins[name];
    writeLock(lock);
  }
  return { name, removed };
}
