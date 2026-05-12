/**
 * trust-store.ts — vendored trust list helpers (Phase 2 vendor, #918 follow-up).
 *
 * Mirrors `src/commands/plugins/trust/{store,impl}.ts` so that
 * `src/commands/shared/{scope-acl,comm-send}.ts` (and any other src/core /
 * src/api / src/lib consumer) can read + append to `<CONFIG_DIR>/trust.json`
 * without reaching across the plugin boundary into the trust plugin.
 *
 * After the follow-up "prune" PR removes the trust plugin's source, this
 * vendored copy is the canonical location for the helper logic; the plugin
 * (if it survives at all) becomes a thin CLI dispatcher.
 *
 * Forgiving load semantics — missing file, corrupt JSON, or wrong shape
 * all fall back to `[]` rather than throwing. Atomic writes via tmp +
 * rename(2). No file lock — Phase 1 / Phase 2 trust adds are operator-driven
 * and racing writers aren't a realistic workload.
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

export interface TrustEntryOnDisk {
  sender: string;
  target: string;
  addedAt: string;
}

export type TrustListOnDisk = TrustEntryOnDisk[];

function activeConfigDir(): string {
  if (process.env.MAW_HOME) return join(process.env.MAW_HOME, "config");
  if (process.env.MAW_CONFIG_DIR) return process.env.MAW_CONFIG_DIR;
  return join(homedir(), ".config", "maw");
}

export function trustPath(): string {
  return join(activeConfigDir(), "trust.json");
}

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
    return parsed.filter(
      (e: unknown): e is TrustEntryOnDisk =>
        e !== null &&
        typeof e === "object" &&
        typeof (e as Record<string, unknown>).sender === "string" &&
        typeof (e as Record<string, unknown>).target === "string" &&
        typeof (e as Record<string, unknown>).addedAt === "string",
    );
  } catch {
    return [];
  }
}

export function saveTrust(list: TrustListOnDisk): void {
  const path = trustPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Symmetric pair equality. `{a, b}` matches `{b, a}` — trust is direction-agnostic. */
export function samePair(
  a: { sender: string; target: string },
  b: { sender: string; target: string },
): boolean {
  return (
    (a.sender === b.sender && a.target === b.target) ||
    (a.sender === b.target && a.target === b.sender)
  );
}

export interface AddResult {
  added: boolean;
  entry: TrustEntryOnDisk;
}

/**
 * Add a sender↔target trust pair. Idempotent in both directions:
 * `add(a, b)` after `add(a, b)` or `add(b, a)` is a no-op. Throws on
 * empty / equal sender+target — self-trust is meaningless because
 * `evaluateAcl()` already allows self-messages unconditionally.
 */
export function cmdAdd(sender: string, target: string): AddResult {
  if (!sender || typeof sender !== "string") {
    throw new Error("trust add: sender must be a non-empty string");
  }
  if (!target || typeof target !== "string") {
    throw new Error("trust add: target must be a non-empty string");
  }
  if (sender === target) {
    throw new Error(
      `trust add: refusing self-trust pair "${sender}↔${sender}" — self-messages are always allowed`,
    );
  }

  const list = loadTrust();
  const candidate = { sender, target };
  for (const existing of list) {
    if (samePair(existing, candidate)) {
      return { added: false, entry: existing };
    }
  }

  const entry: TrustEntryOnDisk = {
    sender,
    target,
    addedAt: new Date().toISOString(),
  };
  list.push(entry);
  saveTrust(list);
  return { added: true, entry };
}
