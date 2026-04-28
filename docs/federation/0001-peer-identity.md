# ADR 0001: Federation Peer Identity

**Status**: Accepted (2026-04-28)
**Discussion**: [#629](https://github.com/Soul-Brews-Studio/maw-js/issues/629)
**Tracking**: [#804](https://github.com/Soul-Brews-Studio/maw-js/issues/804)
**Target**: v26.5.x alpha cycle, hard-cut at v27.0.0
**Authors**: mawjs-oracle@m5, mawjs-oracle@white

## Context

Federation between maw nodes today identifies peers by a bare alias in `peers.json` and authenticates them with a fleet-wide shared secret (`federationToken`). This is sufficient for "do these two laptops trust each other" but breaks under six pressures we hit during the 2026-04-28 multi-machine session:

1. **Attribution lie** — federation messages arrive in the receiver's input stream as if from the user. A body-level convention (`[<oracle>:<node>]`) emerged organically as ad-hoc attribution but is forgeable and unenforced.
2. **Reachability asymmetry** — `maw health` probes `/info` (read path) while `maw hey` writes to `/api/send` (write path). The two failed independently (~30 minute outage, m5↔white iter17). Health reported green while writes returned `HTTP 0`.
3. **Version skew** — peers running different code points diverged at the schema layer. `WakeBody` rejected `{target}` on a peer expecting `{oracle}` (resolved retroactively in #796 with dual-field acceptance).
4. **Authorization conflation** — operational identity (git commit author) and federation identity are the same name (`nazt`) but distinct concerns. GitHub workflows that depend on multi-party review collapse to single-party silently.
5. **Sub-agent boundary** — sub-agents (Agent tool spawns, /team-agents members) share cognitive substrate with their parent but have no federation identity, no `maw health` presence, no addressability. Easy to miscount.
6. **Original disambiguation pressure** (#629 Q2) — `neo` means different oracles in different nodes; bare-name federation collisions are a real onboarding hazard.

A naming-scheme decision (`neo` vs `neo@clinic-nat.local`) addresses one of these (#6). The other five are real and need to be handled together. This ADR records the joint decision.

## Decision

Federation peer identity has two tiers: a **canonical address** that every message carries, and a **per-peer cryptographic identity** that messages are signed with.

### Tier 1 — Canonical address: `<oracle>:<node>`

Always two parts, always qualified, drawn from `maw.config.json`:

- `<oracle>` — the oracle name (`mawjs`, `neo`, `colab`)
- `<node>` — the node name from `config.node` (`m5`, `white`, `mba`)

Examples: `mawjs:m5`, `mawjs:white`, `unconference:mba`.

Bare-name routing is a hard error (already enforced in #785). The 3-part on-the-wire form (`<node>:<session>:<window>`) is preserved for instance addressing within a node; identity is the 2-part conceptual form.

**Multi-oracle-per-node** is a naming convention, not a protocol concern: oracle names must be unique within a node. `maw doctor` enforces; `maw serve` warns at boot if it detects a duplicate `<oracle>:<node>` claim across `peers.json`.

### Tier 2 — Cryptographic identity: per-peer keypair

Each peer holds a long-lived keypair stored at `<config-dir>/peer-key` (mode 0600), generated on first `maw serve` boot. The pubkey is published via `/info`:

```json
{
  "oracle": "mawjs",
  "node": "white",
  "version": "26.5.0",
  "endpoints": ["/api/send", "/api/wake", "/api/sleep", "/api/pane-keys", "/api/probe"],
  "pubkey": "ed25519:abcd...",
  "clockUtc": "2026-04-28T17:42:00Z"
}
```

Federation messages carry `from: "<oracle>:<node>"` as a **protocol field** (not body convention) and are signed with the sender's private key. Receiver verifies against the cached pubkey.

Key persists across reboots (SSH host-key model). Same `pubkey` = same peer; intentional rotation is operator action via a future `maw keys rotate` command (out of scope for this ADR).

### Trust establishment — TOFU

First contact establishes; mismatch thereafter is a refusal. Operators may pre-share pubkeys via `peers.json` for stricter setups; default is TOFU.

`federationToken` and `pubkey` are **separate layers**:
- `federationToken` gates *fleet membership* — "are you supposed to be in this fleet at all"
- `pubkey` gates *per-peer continuity* — "are you the peer I last spoke with"

Token revoked → fleet membership revoked. Pubkey changed → peer treated as new (TOFU re-runs).

### Sub-agent boundary

Sub-agents have no federation identity. They speak as their parent in the protocol envelope. `from: "mawjs:m5"` for any message reaching the wire from a process tree rooted at `mawjs:m5`, regardless of which sub-agent emitted it.

Sub-agent attribution for **human readers** belongs in the message body ("reviewer A noticed: ..."), not the protocol envelope.

This is a deliberate political-vs-cognitive distinction: federation is a graph of publicly addressable handles, not a graph of minds.

### Health probe — `POST /api/probe`

`/info` is for capability discovery (read path, cached, low cost). It is NOT a health signal — read path can be up while write path is down.

A new endpoint `POST /api/probe` exercises the same code path as `/api/send` (without delivering). `maw health` calls `/api/probe`. Probe response answers "can I send?" honestly.

### Replay window — clock skew

Signed messages carry `signed_at`. Receiver rejects on `|signed_at - now| > config.federationClockSkewSeconds` (default 300s = 5 min). Symmetric — past beyond skew AND future beyond skew both refused.

Default 5 min (not 60s) accommodates real-world heterogeneous fleets including laptops that sleep and mobile nodes with NTP-flaky cellular.

### Asymmetric upgrade window — O6 rule

During the v26.5.x alpha window, peers upgrade asynchronously. The receiver-side decision is keyed on cache state:

| Receiver state | Sender signed? | Outcome |
|---|---|---|
| No cached pubkey | Unsigned (legacy) | Accept (TOFU bootstrap) |
| No cached pubkey | Signed | Accept + cache pubkey (TOFU) |
| Cached pubkey | Unsigned | **Refuse** ("you used to sign — what changed?") |
| Cached pubkey | Signed, valid | Accept |
| Cached pubkey | Signed, mismatch | Refuse + alert (rotation OR impersonation) |

Accepting unsigned is a **one-time-per-peer** concession during alpha. Once a peer signs once, it must always sign. Operator can `maw peers forget <peer>` to re-TOFU after legitimate factory-reset / key loss.

### Migration to v27 — hard cut

No `legacy: true` flag. The alpha cycle (v26.5.x) is the migration window. Peers running pre-RFC code at v27.0.0 release are refused with a clear error pointing to this ADR.

This mirrors #785's deprecation→hard-error pattern. A flag we don't delete is a flag we maintain forever.

### Authorization (out of scope)

Operational identity (git commit author, GitHub auto-approve eligibility) is distinct from federation identity. Workflows requiring multi-party review need a second human-owned account, not a federation workaround. Documented in CONTRIBUTING.md as part of step 6.

## Consequences

**Closes**:
- Attribution lie — `from:` is a signed protocol field, not a body convention
- Reachability asymmetry — probe and send share a code path
- Version skew — `/info` advertises capabilities, mismatch can be negotiated or refused explicitly
- Disambiguation pressure (#629 Q2) — every address always qualified
- Sub-agent boundary — explicit non-peers, parent owns the wire

**Doesn't close (deferred)**:
- Cross-fleet federation (different `federationToken`s) — v27+
- Discovery (peer auto-finds peer) — separate concern
- Pubkey rotation UX — operator-driven for v26.5.x; auto-rotation deferred
- Capability negotiation algorithm — pick simplest (refuse on mismatch) for v26.5.x

**New requirements**:
- Operators must run `maw doctor` periodically (or it runs at boot) to catch `<oracle>:<node>` collisions
- Operators must understand that "key changed" = "treat as new peer" — `maw peers forget` is the explicit action
- `peers.json` schema extends to include cached `pubkey` per peer
- Migration window is alpha-cycle-bounded; v27.0.0 hard-cuts unsigned messages

## Implementation order

Tracked in [#804](https://github.com/Soul-Brews-Studio/maw-js/issues/804). Six steps:

1. Extend `/info` response: `version + endpoints + pubkey + clockUtc`
2. Cache per-peer pubkey on first contact (TOFU)
3. `maw doctor` + boot-time duplicate `<oracle>:<node>` detection
4. **KEYSTONE** — `from:` protocol field, signed, verified on receive (O6 table)
5. `POST /api/probe` (real write path), `maw health` switches
6. **DEADLINE v27** — hard-cut unsigned messages

Steps 1–3 are independent and can ship in any order. Step 4 is the load-bearing security primitive. Step 5 is debug-quality-of-life. Step 6 is the deadline.

## References

- [#629](https://github.com/Soul-Brews-Studio/maw-js/issues/629) — RFC discussion (m5 draft + white refinement + m5 convergence)
- [#804](https://github.com/Soul-Brews-Studio/maw-js/issues/804) — Implementation tracking issue
- [#785](https://github.com/Soul-Brews-Studio/maw-js/pull/785) — Phase 2 bare-name hard error (pattern this ADR mirrors for v27 migration)
- [#191](https://github.com/Soul-Brews-Studio/maw-js/issues/191) — Loopback bypass / X-Forwarded-For (informs trust model)
- [#795](https://github.com/Soul-Brews-Studio/maw-js/issues/795) — Schema drift between deployed peers (motivates capability discovery)
- [#798](https://github.com/Soul-Brews-Studio/maw-js/issues/798) — `/api/wake` unauth (informs threat model)
- `docs/rfcs/629-peer-identity.md` — Earlier draft RFC (superseded by this ADR)
- `docs/federation/consent-design.md` — Companion spec (PIN consent primitive)
- `src/lib/federation-auth.ts` — Existing HMAC implementation (the code this ADR augments)
