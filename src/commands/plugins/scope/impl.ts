/**
 * maw scope — subcommand implementations (#642 Phase 1, primitive only).
 *
 * Pure(-ish) functions that read and write per-scope JSON files under
 * `<CONFIG_DIR>/scopes/<name>.json`. Phase 1 ships ONLY the data primitive
 * + CLI verbs (list / create / show / delete). ACL evaluation, the trust
 * list, and the cross-scope approval queue are deferred to follow-up
 * issues — see #642 for the full picture.
 *
 * Design decisions:
 *   - One JSON file per scope (vs. a single index file) so a future
 *     `maw scope edit` can be a plain text edit; concurrent writes touch
 *     disjoint files; and corruption blasts at most one scope.
 *   - Path resolution is a function (not a const) so tests can override
 *     `MAW_CONFIG_DIR` per-test and get a fresh path each call. Mirrors
 *     the pattern in src/commands/plugins/team/oracle-members.ts.
 *   - No file lock (yet) — Phase 1 is operator-driven; concurrent
 *     multi-writer edits are not a real workload here. Phase 2 routing
 *     enforcement reads scopes; if writes ever race, we'll add a lock
 *     mirroring src/commands/plugins/peers/lock.ts.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { TScope } from "../../../lib/schemas";

// Scope name validation — same alphabet as peers aliases. Slug-safe so the
// name can double as a filename without escaping.
const SCOPE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateScopeName(name: string): string | null {
  if (!SCOPE_NAME_RE.test(name)) {
    return `invalid scope name "${name}" (must match ^[a-z0-9][a-z0-9_-]{0,63}$)`;
  }
  return null;
}

// ─── Paths ───

/**
 * Resolve the active config dir at call time (not import time) so tests can
 * point the directory at a temp path per-test by setting MAW_CONFIG_DIR /
 * MAW_HOME in beforeEach. Mirrors the precedence logic in src/core/paths.ts
 * — but as a function instead of a module-level const, so successive calls
 * see env mutations made between them.
 *
 *   1. MAW_HOME → <MAW_HOME>/config (instance mode, see #566)
 *   2. MAW_CONFIG_DIR override (legacy)
 *   3. Default singleton ~/.config/maw/
 *
 * In production the env doesn't change between CLI startup and command
 * dispatch, so the live read returns the same path the cached CONFIG_DIR
 * would have. In tests, the live read is what makes per-test isolation work.
 */
function activeConfigDir(): string {
  if (process.env.MAW_HOME) return join(process.env.MAW_HOME, "config");
  if (process.env.MAW_CONFIG_DIR) return process.env.MAW_CONFIG_DIR;
  return join(homedir(), ".config", "maw");
}

export function scopesDir(): string {
  return join(activeConfigDir(), "scopes");
}

export function scopePath(name: string): string {
  return join(scopesDir(), `${name}.json`);
}

function ensureScopesDir(): void {
  mkdirSync(scopesDir(), { recursive: true });
}

// ─── Read ───

export function loadScope(name: string): TScope | null {
  const path = scopePath(name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as TScope;
  } catch {
    return null;
  }
}

export function cmdList(): TScope[] {
  ensureScopesDir();
  const dir = scopesDir();
  const files = readdirSync(dir).filter(f => f.endsWith(".json"));
  const out: TScope[] = [];
  for (const f of files) {
    const name = f.replace(/\.json$/, "");
    const s = loadScope(name);
    if (s) out.push(s);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function cmdShow(name: string): TScope | null {
  const nameErr = validateScopeName(name);
  if (nameErr) throw new Error(nameErr);
  return loadScope(name);
}

// ─── Write ───

export interface CreateOptions {
  name: string;
  members: string[];
  lead?: string;
  ttl?: string | null;
}

/**
 * Create a new scope. Refuses to overwrite — operators must `delete`
 * first. This is intentional: Phase 2 routing will key on scope identity,
 * and silently swapping members under a name would be surprising.
 */
export function cmdCreate(opts: CreateOptions): TScope {
  const nameErr = validateScopeName(opts.name);
  if (nameErr) throw new Error(nameErr);
  if (!opts.members || opts.members.length === 0) {
    throw new Error(`scope "${opts.name}" must have at least one member`);
  }
  for (const m of opts.members) {
    if (typeof m !== "string" || m.length === 0) {
      throw new Error(`scope "${opts.name}" has an empty/invalid member entry`);
    }
  }
  if (opts.lead && !opts.members.includes(opts.lead)) {
    throw new Error(`scope "${opts.name}" lead "${opts.lead}" is not in members`);
  }

  ensureScopesDir();
  const path = scopePath(opts.name);
  if (existsSync(path)) {
    throw new Error(`scope "${opts.name}" already exists at ${path} — delete it first to recreate`);
  }

  const scope: TScope = {
    name: opts.name,
    members: [...opts.members],
    created: new Date().toISOString(),
    ttl: opts.ttl ?? null,
  };
  if (opts.lead) scope.lead = opts.lead;

  // Atomic-ish write via tmp + rename. Cheap insurance against a partial
  // file on crash; same trick as src/commands/plugins/peers/store.ts.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(scope, null, 2) + "\n");
  renameSync(tmp, path);
  return scope;
}

export function cmdDelete(name: string): boolean {
  const nameErr = validateScopeName(name);
  if (nameErr) throw new Error(nameErr);
  const path = scopePath(name);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

// ─── Format ───

export function formatList(rows: TScope[]): string {
  if (!rows.length) return "no scopes";
  const header = ["name", "members", "lead", "ttl", "created"];
  const lines = rows.map(r => [
    r.name,
    r.members.join(","),
    r.lead ?? "-",
    r.ttl ?? "-",
    r.created,
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...lines.map(l => l[i].length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [fmt(header), fmt(widths.map(w => "-".repeat(w))), ...lines.map(fmt)].join("\n");
}
