/**
 * maw trust — subcommand implementations (#842 Sub-B).
 *
 * Pure(-ish) functions that read and write `<CONFIG_DIR>/trust.json`
 * via {@link ./store}. Sub-B ships the data primitive + CLI verbs
 * (list / add / remove). Caller integration into `comm-send.ts` lives
 * in Sub-C — same staging discipline as Sub-A's scope-acl.
 *
 * Design decisions:
 *   - Add is idempotent: re-adding the same pair (in either direction
 *     — trust is symmetric) is a no-op, not an error. Operators
 *     shouldn't have to remember whether they already trusted a pair.
 *   - Remove is exact-match-or-error: removing a non-existent pair
 *     surfaces a clear error rather than silently no-op. Mirrors the
 *     "loud miss" convention from `scope delete`.
 *   - Format mirrors `scope/impl.ts::formatList` — operator-friendly
 *     padded columns, sorted by addedAt for chronological context.
 */
import { loadTrust, samePair, saveTrust, type TrustEntryOnDisk } from "./store";

// Re-export storage helpers so callers can `import { loadTrust } from
// "./impl"` without two import paths. Mirrors how scope/impl.ts exposes
// `scopesDir` / `scopePath` from a single module.
export { loadTrust, saveTrust, trustPath } from "./store";
export type { TrustEntryOnDisk, TrustListOnDisk } from "./store";

// ─── Read ───

export function cmdList(): TrustEntryOnDisk[] {
  const list = loadTrust();
  // Stable sort — addedAt ISO is lexicographically sortable. Older
  // entries first so the operator sees the chronological story of
  // how the trust list grew.
  return [...list].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
}

// ─── Write ───

export interface AddResult {
  added: boolean;        // true if a new entry was written, false if duplicate
  entry: TrustEntryOnDisk;
}

/**
 * Add a sender↔target trust pair. Idempotent in both directions:
 * `add(a, b)` after `add(a, b)` or `add(b, a)` is a no-op. Returns
 * `added: false` plus the existing entry so the CLI can print
 * "already trusted" instead of a fake success.
 *
 * Validates that sender / target are non-empty and not equal — a
 * self-trust pair is meaningless because `evaluateAcl()` already
 * allows self-messages unconditionally (rule 1 of the decision matrix
 * in scope-acl.ts).
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

/**
 * Remove a sender↔target trust pair. Symmetric match — removing
 * `(b, a)` succeeds even if disk has `{sender: a, target: b}`.
 *
 * Returns the removed entry, or throws if no matching pair exists.
 * The CLI dispatcher catches the throw and converts to a non-zero
 * exit so scripts can detect "nothing to remove".
 */
export function cmdRemove(sender: string, target: string): TrustEntryOnDisk {
  if (!sender || typeof sender !== "string") {
    throw new Error("trust remove: sender must be a non-empty string");
  }
  if (!target || typeof target !== "string") {
    throw new Error("trust remove: target must be a non-empty string");
  }

  const list = loadTrust();
  const candidate = { sender, target };
  const idx = list.findIndex(e => samePair(e, candidate));
  if (idx < 0) {
    throw new Error(
      `trust remove: no entry found for "${sender}↔${target}"`,
    );
  }
  const [removed] = list.splice(idx, 1);
  saveTrust(list);
  return removed;
}

// ─── Format ───

export function formatList(rows: TrustEntryOnDisk[]): string {
  if (!rows.length) return "no trust entries";
  const header = ["sender", "target", "addedAt"];
  const lines = rows.map(r => [r.sender, r.target, r.addedAt]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...lines.map(l => l[i].length)),
  );
  const fmt = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [
    fmt(header),
    fmt(widths.map(w => "-".repeat(w))),
    ...lines.map(fmt),
  ].join("\n");
}
