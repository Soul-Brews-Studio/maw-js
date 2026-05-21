export interface CanonicalSessionNameInput {
  /** Resolved oracle/repo/window name, with or without -oracle. */
  oracle: string;
  /** Optional numeric fleet slot. When present, returns NN-<stem>. */
  slot?: number;
}

function sanitizeSessionStem(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._\-]/g, "")
    .replace(/\.{2,}/g, ".").replace(/^[-.]+/, "").replace(/(?<![-.])[-.]+$/, "").slice(0, 50);
}

/**
 * Canonical readable tmux session name stem for an oracle.
 *
 * Pure/portable by design: maw-rs can port the fixture contract directly.
 * It strips fleet slot prefixes and the oracle repo suffix while preserving
 * meaningful internal dashes (`mawjs-codex`, not `mawjscodex`).
 */
export function canonicalSessionName(input: string | CanonicalSessionNameInput): string {
  const oracle = typeof input === "string" ? input : input.oracle;
  const slot = typeof input === "string" ? undefined : input.slot;
  const stem = sanitizeSessionStem(oracle)
    .replace(/^\d+-/, "")
    .replace(/(?:\.git)?$/, "")
    .replace(/-oracle$/i, "");
  if (slot === undefined) return stem;
  if (!Number.isSafeInteger(slot) || slot < 0 || slot > 99) {
    throw new Error(`invalid fleet slot '${slot}'`);
  }
  return `${String(slot).padStart(2, "0")}-${stem}`;
}
