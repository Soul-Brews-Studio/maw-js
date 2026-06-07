/**
 * trust-store.ts — vendored trust list helpers (Phase 2 vendor, #918 follow-up).
 *
 * Mirrors `src/commands/plugins/trust/{store,impl}.ts` so that
 * `src/commands/shared/{scope-acl,comm-send}.ts` (and any other src/core /
 * src/api / src/lib consumer) can read + append to `<STATE_DIR>/trust.json`
 * without reaching across the plugin boundary into the trust plugin.
 * Legacy `<CONFIG_DIR>/trust.json` files remain readable so existing
 * approvals migrate forward on the next write instead of disappearing.
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
import { dirname } from "path";
import { mawConfigPath, mawStatePath } from "../core/xdg";

export interface TrustEntryOnDisk {
  sender: string;
  target: string;
  addedAt: string;
}

export type TrustListOnDisk = TrustEntryOnDisk[];

export function trustPath(): string {
  return mawStatePath("trust.json");
}

function legacyTrustPath(): string {
  return mawConfigPath("trust.json");
}

function readableTrustPath(): string | null {
  const primary = trustPath();
  if (existsSync(primary)) return primary;
  const legacy = legacyTrustPath();
  if (legacy !== primary && existsSync(legacy)) return legacy;
  return null;
}

export function loadTrust(): TrustListOnDisk {
  const path = readableTrustPath();
  if (!path) return [];
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
