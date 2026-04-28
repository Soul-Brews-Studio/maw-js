/**
 * peers/duplicate-detect.ts — #804 Step 3.
 *
 * Pure logic that scans the peer cache for duplicate `<oracle>:<node>` claims.
 * Two peers in `peers.json` advertising the same `(oracle, node)` pair is
 * almost certainly operator confusion — typically a copy-pasted alias setup,
 * a forgotten `maw peers remove` after a node migration, or a fleet split-
 * brain where the same identity got TOFU'd from two different URLs.
 *
 * Per ADR docs/federation/0001-peer-identity.md ("Crypto solves can't-fake;
 * doctor + boot-time check solves operator confusion") — this layer does NOT
 * refuse anything. It surfaces collisions; the operator decides whether to
 * `maw peers remove` the loser, rename a node, or accept (multi-oracle on a
 * single node, where the *oracle* names differ even though the *node* is one
 * physical machine, is fine and won't trigger this — the key is the full
 * `<oracle>:<node>` pair).
 *
 * Pure: no fs, no network. Caller passes in the peer set + optional local
 * identity. That makes the module trivial to test and lets both the doctor
 * subsystem and the `maw serve` startup hook reuse the same code path.
 */
import type { Peer } from "./store";

/** A single collision: two-or-more peers (or local + peers) sharing one key. */
export interface DuplicateClaim {
  /** Canonical `<oracle>:<node>` key the peers collide on. */
  key: string;
  /** All claimants — alias `"<local>"` is the running maw process itself. */
  claimants: Array<{ alias: string; url?: string }>;
}

/**
 * Build the map of `<oracle>:<node>` → claimants.
 *
 * Peers without an `identity` field are skipped (legacy peers; their oracle
 * may differ from "mawjs" silently — surfacing them as collisions would be
 * a false-positive against pre-Step-1 nodes that simply haven't been probed
 * since the upgrade).
 *
 * The local identity is included as alias `"<local>"` so the boot-time check
 * can spot "this maw IS something I'm also calling a peer" (often happens
 * when an operator copy-pastes a federation snippet on the wrong machine).
 */
export function findDuplicateIdentities(
  peers: Record<string, Peer>,
  local?: { oracle: string; node: string },
): DuplicateClaim[] {
  const groups = new Map<string, Array<{ alias: string; url?: string }>>();

  if (local) {
    const localKey = `${local.oracle}:${local.node}`;
    groups.set(localKey, [{ alias: "<local>" }]);
  }

  for (const [alias, peer] of Object.entries(peers)) {
    if (!peer?.identity) continue;
    const { oracle, node } = peer.identity;
    if (!oracle || !node) continue;
    const key = `${oracle}:${node}`;
    const arr = groups.get(key) ?? [];
    arr.push({ alias, url: peer.url });
    groups.set(key, arr);
  }

  const dups: DuplicateClaim[] = [];
  for (const [key, claimants] of groups) {
    if (claimants.length >= 2) dups.push({ key, claimants });
  }
  // Stable order: by key, alphabetically.
  dups.sort((a, b) => a.key.localeCompare(b.key));
  return dups;
}

/**
 * Format a one-line warning suitable for `maw doctor` output OR a `maw serve`
 * startup log. Caller wraps in colors per its own log surface.
 */
export function formatDuplicate(d: DuplicateClaim): string {
  const tail = d.claimants
    .map(c => (c.url ? `${c.alias} (${c.url})` : c.alias))
    .join(", ");
  return `duplicate <oracle>:<node> claim "${d.key}" — ${tail}`;
}

/**
 * Boot-time hook used by `startServer()`. Loads the peer cache + the
 * caller-supplied local identity, then writes a YELLOW warning per
 * collision via `console.warn`. Never throws — boot must continue per ADR.
 *
 * Returns the duplicates list so tests / callers can assert on it.
 */
export function warnDuplicatesAtBoot(args: {
  peers: Record<string, Peer>;
  local?: { oracle: string; node: string };
  log?: (msg: string) => void;
}): DuplicateClaim[] {
  const log = args.log ?? ((m: string) => console.warn(m));
  const dups = findDuplicateIdentities(args.peers, args.local);
  for (const d of dups) {
    log(`\x1b[33m⚠ ${formatDuplicate(d)}\x1b[0m`);
    log(`\x1b[33m  investigate with \`maw peers list\` and \`maw peers remove <alias>\` if stale.\x1b[0m`);
  }
  return dups;
}
