# RFC: Federation hardening roadmap (#2784)

Status: Accepted roadmap (design capture)
Date: 2026-06-13
Tracking: [#2784](https://github.com/Soul-Brews-Studio/maw-js/issues/2784)
Related: [#2752](https://github.com/Soul-Brews-Studio/maw-js/issues/2752), [#2776](https://github.com/Soul-Brews-Studio/maw-js/issues/2776), [#2777](https://github.com/Soul-Brews-Studio/maw-js/issues/2777), [#2779](https://github.com/Soul-Brews-Studio/maw-js/issues/2779)
Companion: [`docs/federation/0001-peer-identity.md`](../federation/0001-peer-identity.md)

## 1. Purpose

This RFC records the current design verdict for maw federation hardening after a two-pass review: an oracle-draft verdict, then an adversarial source cross-check against `origin/alpha` during the June 2026 federation sprint.

This is a roadmap, not a single patch plan. Several immediate defects have already been fixed in adjacent issues; this document preserves the remaining architectural decisions and the next implementation seams so future work does not re-litigate the same security model.

## 2. Current model, as of this RFC

maw federation currently has three overlapping trust layers:

1. **Fleet membership token** — shared `federationToken` HMAC for protected write routes.
2. **Peer-continuity signature** — v3 `X-Maw-From` / `X-Maw-Signature-V3` identity continuity headers.
3. **Receiver durability** — receiver-side inbox persistence when a remote send reaches a peer but cannot be delivered to a live pane.

The direction is correct: fleet membership and peer continuity are separate concepts, and receiver-side durability prevents messages from disappearing after a peer accepts them. The present design is still incomplete because the shared token is mesh-wide, the signed identity currently authenticates the node half more strongly than the oracle half, and send delivery is single-attempt from the sender side.

## 3. Decisions that remain right

### 3.1 Layered auth is the right shape

`federationToken` answers “is this caller in the fleet?”; from-signing answers “is this still the peer identity I previously saw?” These are different questions and should stay layered instead of replacing one with the other.

Source anchors:

- `src/lib/federation-auth.ts` — canonical HMAC / v3 signing and verification helpers.
- `src/core/transport/curl-fetch.ts` — outgoing peer requests stack the shared-token signature with optional `from` signing.
- `src/lib/elysia-auth.ts` — protected-route middleware requires the shared-token layer for non-loopback protected writes.

### 3.2 Receiver durable-on-receipt is useful, but bounded

`/api/send` can persist receiver inbox records when tmux is unavailable, the pane is not live, the target is busy, or delivery fails after receipt. This is receiver durability, not sender at-least-once delivery.

Source anchors:

- `src/api/sessions.ts` — send endpoint acceptance, live-pane checks, busy handling, and inbox fallback.
- `src/commands/shared/receiver-inbox.ts` — atomic receiver inbox writes with collision-safe filenames.

### 3.3 Discovery is not trust

Scout / Zenoh / peer-status discovery surfaces are presence and reachability inputs. They must not become implicit authorization. Pairing, peer records, token admission, and identity continuity remain separate trust decisions.

Source anchors:

- `src/transports/scout-pair-proof.ts` — scout pairing proof helper.
- `src/config/validate-ext.ts` — federation config validation.
- `src/lib/peers/tofu.ts` — peer identity continuity decisions.

### 3.4 Wake-before-send stays best-effort

Wake-before-send improves availability but cannot be the correctness boundary. A failed wake should not be confused with a failed authenticated send, and a successful wake should not be treated as proof of durable delivery.

Source anchor: `src/commands/shared/comm-send.ts`.

## 4. Confirmed flaws

### 4.1 Mesh-wide shared secret

A single `federationToken` remains the bootstrap/admission secret for the whole mesh. One compromised peer can use the same secret until the entire fleet rotates it. This is acceptable for alpha bootstrap, but it is not per-peer revocation.

Roadmap direction: **B — per-peer admission keys**.

### 4.2 Sender has no durable outbox

Sender-side `maw hey` / `maw send` is still a single attempt from the operator’s perspective. The receiver may durably store a message after receipt, but the sender does not durably enqueue, retry, or reconcile acknowledgements when the peer is down.

`src/core/message-queue.ts` is a local in-memory queue for local dispatch pressure; it is not a persistent federation outbox.

Roadmap direction: **C — durable delivery semantics**.

### 4.3 No replay cache, nonce, ordering, or ack sequence

Current signatures include timestamp skew checks, and v3 binds the body. That prevents body swapping under v3, but it does not prevent replay within the accepted clock window and does not provide per-peer sequence, idempotency, or acknowledgement semantics.

Roadmap direction: **C — durable delivery semantics**.

### 4.4 Node identity is stronger than oracle identity

The most important architectural miss: federation identity currently conflates `node` as the hard key with `oracle` as a human-facing half. from-signing validates continuity for the peer node, but the oracle half is still more informational than authoritative. Attribution surfaces then consume the signed `from` header for human display.

This leaves a multi-oracle-per-node weakness: a valid node can claim a different oracle name unless future work binds oracle identity into the admission key or per-oracle credential.

Roadmap direction: **A + B** — tighten from-signature enforcement and make admission keys carry the identity that authorization decisions actually consume.

Source anchors:

- `src/lib/elysia-auth.ts` — `X-Maw-From` auth middleware and protected-write gate.
- `src/api/sessions.ts` — sender attribution extraction for received messages.
- `src/lib/federation-auth.ts` — v3 `from` verification primitives.

## 5. Corrections to avoid stale conclusions

### 5.1 Body binding is mixed, not absent

v3 from-signing binds the request body through the canonical signed payload. The legacy token/HMAC path remains intentionally bodyless in compatibility paths. The precise statement is:

- legacy/token writes are not uniformly body-bound;
- v3 writes are body-bound;
- both are replayable within the accepted clock window unless future nonce/replay-cache work lands.

### 5.2 TOFU does not fail open for protected writes after pinning

Once a cached signed identity exists, cached-plus-unsigned protected writes are refused. Legacy accept-with-warning behavior belongs to discovery / identity-probe upgrade paths, not to protected write authorization.

Source anchor: `test/isolated/from-signing-verify.test.ts`.

### 5.3 Request-body storage is not a persistent attacker-keyed map

The current raw-body capture uses a `WeakMap<Request, Uint8Array>` and deletes on read. That is still worth keeping small and audited, but the larger issue is identity attribution, not an unbounded persistent map keyed by attacker input.

Source anchor: `src/lib/elysia-auth.ts`.

## 6. Roadmap directions

### A — from-signature enforcement

Goal: continue the #2776 direction without turning v3 into a replacement for fleet admission.

Protected-write rules should converge to:

1. Shared-token HMAC must pass for every protected non-loopback write in the current model.
2. If `X-Maw-From` is present and cached, v3 must verify against that cached identity.
3. If `X-Maw-From` is signed but uncached, protected writes should not silently bootstrap trust. Allow bootstrap on identity/pair/read flows only, or record it for operator admission.
4. v3-only protected federation remains out of scope until per-peer admission keys exist.
5. Oracle attribution must eventually be authenticated, not just displayed.

Candidate implementation issues:

- enforce “uncached signed identity cannot bootstrap on protected writes”;
- add regression tests for signed-uncached protected writes vs identity/bootstrap routes;
- add explicit tests for spoofed oracle half on a valid node.

### B — per-peer admission keys

Goal: replace the mesh-wide secret as the long-term protected-write admission primitive.

Proposed shape:

- Extend peer records with `keyId`, active key material metadata, `createdAt`, optional `rotatesAt`, and optional `revokedAt`.
- Use the current `federationToken` only for bootstrap / pair proof during the migration window.
- Sign protected writes with a per-peer key selected by `keyId`.
- Canonical payload should include `method:path:timestamp:bodyHash:keyId` plus the authenticated sender identity.
- Receiver chooses the correct key after resolving and admitting the peer record; revoked keys fail closed.

Open design point: whether the per-peer key binds `<node>` only, `<oracle>:<node>`, or a future per-oracle subkey. This RFC recommends binding the authorization identity that receiver attribution and trust surfaces actually consume, not just the node.

Candidate implementation issues:

- peer-store schema migration for `keyId` and rotation metadata;
- pair handshake extension for key admission;
- dual-sign rollout before requiring per-peer keys;
- `maw peers rotate/revoke` operator UX.

### C — durable delivery semantics

Goal: make sender delivery explicit and retryable instead of relying on a single remote attempt.

Proposed shape:

- Sender durable outbox using JSONL or SQLite under XDG state.
- `messageId` / idempotency key on every send attempt.
- Receiver dedup table keyed by sender identity + message ID.
- Receiver ack endpoint or ack response body with persisted delivery state.
- Retry with bounded backoff and visible state: `accepted locally for retry`, `remote accepted`, `delivered to pane`, `stored in receiver inbox`.
- Optional per-peer sequence for control operations that require ordering.

Receiver inbox stays valuable: it is durable-on-receipt. Sender outbox adds at-least-once attempt semantics before receipt.

Candidate implementation issues:

- persistent outbox store and CLI status surface;
- idempotency header / field;
- receiver dedup and ack response;
- retry worker and failure classification;
- optional ordered-control channel separate from chat.

## 7. Non-goals for this RFC

- Removing public read endpoints. The v1 lens contract deliberately keeps public reads public; see [`docs/federation.md`](../federation.md).
- Treating consent scopes as base auth. Consent remains action-scoped and opt-in via `MAW_CONSENT`; it is not a replacement for federation auth.
- Changing loopback bypass behavior in this document. Loopback / reverse-proxy hardening is related security debt, but it should be tracked separately so it does not obscure federation peer semantics.
- Making discovery authoritative. Discovery finds peers; admission decides trust.

## 8. Acceptance for future work

Future PRs implementing this roadmap should update this RFC or link their issue in this section.

A hardening PR is not complete unless it states which layer it changes:

- fleet admission;
- peer identity continuity;
- oracle attribution;
- sender durability;
- receiver durability;
- ordering / replay resistance;
- public-read compatibility.

## 9. References

- [#2784](https://github.com/Soul-Brews-Studio/maw-js/issues/2784) — source RFC issue.
- [`docs/federation/0001-peer-identity.md`](../federation/0001-peer-identity.md) — earlier peer-identity ADR.
- [`docs/federation.md`](../federation.md) — public federation lens contract.
- [`docs/federation/consent-design.md`](../federation/consent-design.md) — consent / PIN trust companion design.
- [`docs/plugins/peer-search-rollout.md`](../plugins/peer-search-rollout.md) — peer fanout rollout posture.
