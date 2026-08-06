/**
 * peers/tofu.ts — Trust On First Use cache for peer pubkeys (#804 Step 2).
 *
 * Pure, no-network logic that gets called by every code path which has just
 * fetched a peer's `/api/identity` response. The peer's reply may carry a
 * `pubkey` (Step 1 advertised it; pre-Step-1 peers omit it). We cache the
 * pubkey on first sight and refuse mismatches thereafter.
 *
 * O6 table from ADR docs/federation/0001-peer-identity.md drives the four
 * outcomes here — see `evaluatePeerIdentity` for the truth-table mapping.
 *
 * Design rules (deliberately not in store.ts):
 *   - This module owns the *policy* (when to accept / refuse / warn).
 *   - store.ts owns the *persistence* (how to read/write peers.json safely).
 *   - This module never throws on absent-from-cache — it returns a tagged
 *     decision the caller acts on. Throwing here would couple network code
 *     paths to TOFU state shape.
 *
 * The receive-side (Step 4 signature verification) will reuse the same cache
 * shape; this module is the only writer of `pubkey` / `pubkeyFirstSeen` so
 * there's exactly one place that decides "this pubkey is now pinned".
 */
import type { Peer } from "./store";
import { mutatePeers } from "./store";

export type TofuDecisionKind =
  /** First time we ever see a pubkey for this peer. Cache it. */
  | "tofu-bootstrap"
  /** Cached pubkey matches incoming pubkey. No-op write needed. */
  | "match"
  /** Cached pubkey, peer responded with a different pubkey. Refuse. */
  | "mismatch"
  /**
   * Peer is a legacy node with no `pubkey` field at all. First contact —
   * cache the entry without a pubkey; future Step-1+ contacts will TOFU.
   */
  | "legacy-first-contact"
  /**
   * Peer previously advertised a pubkey but this response omits it.
   * During the v26.5.x migration window we accept-with-warning (rollback
   * scenario). v27 will hard-cut this — see ADR Step 6.
   */
  | "legacy-after-pinned";

export interface TofuDecision {
  kind: TofuDecisionKind;
  alias: string;
  /** The cached pubkey (if any) BEFORE this call. */
  cached?: string;
  /** The pubkey the peer just advertised (if any). */
  observed?: string;
  /** Human-readable description for logs / errors. */
  message: string;
}

export class PeerPubkeyMismatchError extends Error {
  alias: string;
  cached: string;
  observed: string;
  constructor(alias: string, cached: string, observed: string) {
    super(
      `peer pubkey changed for ${alias}: ${cached.slice(0, 16)}… → ${observed.slice(0, 16)}…; ` +
        `manually \`maw peers forget ${alias}\` to re-TOFU`,
    );
    this.name = "PeerPubkeyMismatchError";
    this.alias = alias;
    this.cached = cached;
    this.observed = observed;
  }
}

/**
 * Pure decision function — given the current cache entry and the peer's
 * advertised pubkey (or `undefined` for legacy peers), return what should
 * happen. Persistence is the caller's job (`applyTofuDecision`).
 *
 * The four decisions map directly onto the O6 table cells that are
 * relevant to the *receive an identity response* event (the other O6
 * cells about signed messages are Step 4's concern).
 */
export function evaluatePeerIdentity(
  alias: string,
  peer: Peer | undefined,
  observed: string | undefined,
): TofuDecision {
  const cached = peer?.pubkey;

  // Case 1: peer is brand-new to us OR we've never cached a pubkey.
  if (!cached) {
    if (observed) {
      return {
        kind: "tofu-bootstrap",
        alias,
        observed,
        message: `[tofu] caching pubkey for ${alias} (first sight)`,
      };
    }
    return {
      kind: "legacy-first-contact",
      alias,
      message: `[tofu] ${alias} did not advertise a pubkey (legacy peer; no pin established)`,
    };
  }

  // Case 2: cached pubkey present — must validate.
  if (!observed) {
    return {
      kind: "legacy-after-pinned",
      alias,
      cached,
      message:
        `[tofu] ${alias} previously advertised pubkey ${cached.slice(0, 16)}… but this response omits it; ` +
        `accepting during alpha migration, will hard-fail at v27`,
    };
  }

  if (cached === observed) {
    return {
      kind: "match",
      alias,
      cached,
      observed,
      message: `[tofu] ${alias} pubkey verified`,
    };
  }

  return {
    kind: "mismatch",
    alias,
    cached,
    observed,
    message:
      `peer pubkey changed for ${alias}: ${cached.slice(0, 16)}… → ${observed.slice(0, 16)}…; ` +
      `manually \`maw peers forget ${alias}\` to re-TOFU`,
  };
}

/**
 * Persist the side-effect of `evaluatePeerIdentity`. Bootstrap writes the
 * pubkey + timestamp; mismatch throws; match / legacy-* are no-ops on disk.
 *
 * Throws `PeerPubkeyMismatchError` on `kind === "mismatch"` — caller decides
 * whether to surface to user or swallow (e.g. background sweepers may log
 * and skip; interactive `maw peers add` may fail loud).
 */
export function applyTofuDecision(decision: TofuDecision): void {
  switch (decision.kind) {
    case "tofu-bootstrap": {
      const now = new Date().toISOString();
      mutatePeers((data) => {
        const p = data.peers[decision.alias];
        if (!p) return; // race-safe: peer was forgotten between fetch+apply
        // Defensive: if someone else cached a pubkey between evaluate and
        // apply, treat that as authoritative — re-evaluate would mismatch
        // or match; we don't silently overwrite.
        if (p.pubkey) return;
        p.pubkey = decision.observed!;
        p.pubkeyFirstSeen = now;
      });
      return;
    }
    case "mismatch":
      throw new PeerPubkeyMismatchError(
        decision.alias,
        decision.cached!,
        decision.observed!,
      );
    case "match":
    case "legacy-first-contact":
    case "legacy-after-pinned":
      return;
  }
}

/**
 * One-shot helper: evaluate + apply. Returns the decision so callers can log.
 *
 * Throws `PeerPubkeyMismatchError` on mismatch (caller chooses recovery).
 */
export function tofuRecordPeerIdentity(
  alias: string,
  peer: Peer | undefined,
  observed: string | undefined,
): TofuDecision {
  const decision = evaluatePeerIdentity(alias, peer, observed);
  applyTofuDecision(decision);
  return decision;
}

/**
 * Operator-driven re-TOFU: clears the pinned pubkey for an alias. Used by
 * `maw peers forget <alias>`. Idempotent — clearing a peer that has no
 * pubkey is fine and reports nothing-changed via the return value.
 *
 * Returns:
 *   - "cleared" — pubkey was present and is now removed
 *   - "no-pubkey" — alias exists but had no pubkey (legacy peer)
 *   - "not-found" — alias does not exist
 */
export function forgetPeerPubkey(
  alias: string,
): "cleared" | "no-pubkey" | "not-found" {
  let outcome: "cleared" | "no-pubkey" | "not-found" = "not-found";
  mutatePeers((data) => {
    const p = data.peers[alias];
    if (!p) {
      outcome = "not-found";
      return;
    }
    if (p.pubkey === undefined) {
      outcome = "no-pubkey";
      return;
    }
    delete p.pubkey;
    delete p.pubkeyFirstSeen;
    outcome = "cleared";
  });
  return outcome;
}
