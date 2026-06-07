/**
 * doctor/internal/stale-peers.ts — #1238.
 *
 * Stale-peer detection on top of the TTL helpers in
 * `./peers-store` (mirrored from `plugins/peers/store.ts`).
 *
 * Two surfaces:
 *
 *   - `checkStalePeers()` — read-only doctor entry. Returns `ok:true`
 *     when no peer is stale, `ok:false` with a count + pointer to
 *     `--fix-stale` when there are stale entries. Mirrors the severity
 *     pattern from `checkPeerDuplicates` (#804 Step 3): hard failure
 *     so the operator notices, but the fix is one explicit flag away.
 *
 *   - `cmdFixStalePeers()` — destructive sweep. Prints a preview, runs
 *     a 3s abort window (skipped in MAW_TEST_MODE — same idiom as
 *     `cleanup --zombie-agents`), then removes each stale peer via
 *     `mutatePeers` (atomic, lock-safe). Returns a `DoctorResult`-shape
 *     payload so `cmdDoctor` can return it directly without going
 *     through the regular renderResults path.
 *
 * Self-exclude: this is a registry-only sweep — peers are remote nodes
 * we point at, not the local oracle itself — so there's nothing to
 * exclude. (Contrast with `cleanup --zombie-agents`, which had to
 * exclude the operator's live primary pane.)
 */
import { C } from "maw-js/commands/shared/fleet-doctor-fixer";
import {
  loadPeers,
  mutatePeers,
  isStale,
  getStaleTtlMs,
  staleAgeMs,
  type Peer,
} from "./peers-store";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StalePeer {
  alias: string;
  url: string;
  /** Age in ms since lastSeen (or addedAt for never-probed peers). `null` when timestamps are unparseable. */
  ageMs: number | null;
}

/**
 * Pure: enumerate stale peers from `~/.maw/peers.json` (or `$PEERS_FILE`).
 * Sorted by alias for stable output. Returns `[]` on any load error —
 * the caller turns that into a "skipping" ok:true check.
 */
export function findStalePeers(now: number = Date.now()): StalePeer[] {
  let peers: Record<string, Peer> = {};
  try {
    peers = loadPeers().peers;
  } catch { return []; }
  const ttlMs = getStaleTtlMs();
  return Object.entries(peers)
    .filter(([_, p]) => isStale(p, ttlMs, now))
    .map(([alias, p]) => ({ alias, url: p.url, ageMs: staleAgeMs(p, now) }))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}

/**
 * `maw doctor` entry: surface a count of stale peers and point the
 * operator at the explicit `--fix-stale` removal flag. ok:false on
 * non-zero count so the doctor exit code reflects "needs attention".
 */
export function checkStalePeers(now: number = Date.now()): DoctorCheck {
  const stale = findStalePeers(now);
  if (stale.length === 0) {
    return { name: "peers:stale", ok: true, message: "no stale peers" };
  }
  const days = Math.round(getStaleTtlMs() / DAY_MS);
  return {
    name: "peers:stale",
    ok: false,
    message: `${stale.length} stale peer${stale.length === 1 ? "" : "s"} (>${days}d) — run 'maw doctor --fix-stale' to remove`,
  };
}

/**
 * Destructive: remove every stale peer after a 3s abort window.
 *
 * Test mode (`MAW_TEST_MODE=1`) skips the countdown for deterministic,
 * fast test runs — same pattern as `cmdCleanupZombies`. Removal goes
 * through `mutatePeers` so the lock + atomic write semantics from
 * `peers/store.ts` apply (concurrent writers don't lose updates).
 *
 * Returns a `DoctorResult`-shape payload so the dispatch path in
 * `cmdDoctor` can short-circuit and hand it straight back to index.ts.
 */
export async function cmdFixStalePeers(): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const stale = findStalePeers();
  console.log("");
  console.log(`  ${C.green}✓${C.reset} maw doctor --fix-stale${C.reset}`);
  if (stale.length === 0) {
    console.log(`    ${C.green}✓${C.reset} peers:fix-stale: no stale peers to remove`);
    console.log("");
    return { ok: true, checks: [{ name: "peers:fix-stale", ok: true, message: "no stale peers" }] };
  }

  console.log(`    ${C.yellow}⚠${C.reset} ${stale.length} stale peer${stale.length === 1 ? "" : "s"} to remove:`);
  for (const s of stale) {
    const ago = s.ageMs != null ? `${Math.floor(s.ageMs / DAY_MS)}d ago` : "never seen";
    console.log(`      ${C.yellow}${s.alias}${C.reset}  ${s.url}  ${C.gray}(${ago})${C.reset}`);
  }

  if (!process.env.MAW_TEST_MODE) {
    console.log(`    ${C.yellow}! Removing in 3s — Ctrl-C to abort.${C.reset}`);
    for (let i = 3; i > 0; i--) {
      process.stdout.write(`      ${C.gray}${i}...${C.reset}\r`);
      await Bun.sleep(1000);
    }
    process.stdout.write(`            \r`); // clear countdown line
  }

  let removed = 0;
  for (const s of stale) {
    mutatePeers((d) => {
      if (d.peers[s.alias]) {
        delete d.peers[s.alias];
        removed++;
      }
    });
    console.log(`      ${C.green}✓${C.reset} removed ${s.alias}`);
  }
  const msg = `removed ${removed} stale peer${removed === 1 ? "" : "s"}`;
  console.log(`    ${C.green}✓${C.reset} peers:fix-stale: ${msg}`);
  console.log("");
  return { ok: true, checks: [{ name: "peers:fix-stale", ok: true, message: msg }] };
}
