# PIN Consent Primitive — Design (#644 Phase 1)

**Status**: Phase 1 — shared primitive + `maw hey` gating only.
**Default**: OFF. Opt-in via `MAW_CONSENT=1` env var.

## Problem

Federation today: once two oracles are paired (`maw pair`), every action between them is implicitly trusted. `maw hey peer:agent "msg"` lands without confirmation. `team-invite` would silently spawn agents on a peer. `plugin-install` would fetch + run third-party code without review.

We need a **consent layer** that:

1. Gates untrusted cross-oracle actions on a per-(from, to, action) basis.
2. Uses an out-of-band PIN so the human at the target oracle approves explicitly.
3. Stores trust persistently so repeat actions don't re-prompt.
4. Defaults to OFF (no behavior change for existing users) while giving us a real primitive to dogfood.

## Scope (Phase 1)

| In | Out |
|----|-----|
| `src/core/consent/` shared primitive | `team-invite` integration |
| `maw hey` opt-in gate | `plugin-install` integration |
| `~/.maw/trust.json` | UI surface in maw-ui |
| `~/.maw/consent-pending/<id>.json` | Multi-action scopes (e.g., "all hey for 1h") — Phase 2 |
| `maw consent {list,approve,trust}` | Reject/decline UX (Phase 2 — silent timeout for now) |
| Federation HTTP endpoints | Consent revocation flow |

## State Machine

```
[CLIENT: maw hey peer:agent "msg"]
        │
        ▼ MAW_CONSENT=1?
        ├─ no  → send normally (current behavior)
        └─ yes
            │
            ▼ isTrusted(me, peer, "hey")?
            ├─ yes → send normally
            └─ no
                │
                ▼ POST /api/consent/request → peer
                │  body: { id, from, action, summary, pin (HASHED), expiresAt }
                │
                ▼ persist locally: ~/.maw/consent-pending/<id>.json
                │  status: "pending"
                │
                ▼ print: "PIN sent to peer:agent. Approval ID: <id>. Run 'maw consent list' on peer."
                │  exit 0 — message NOT delivered yet
                │
                (peer human runs `maw consent approve <id> <PIN>`)
                │
                ▼ /api/consent/<id>/status → polled by client OR client re-runs hey
                │
                ▼ on approval:
                  - peer writes trust entry locally (peer trusts me for "hey")
                  - client writes trust entry locally (me trusts peer back, symmetric)
                  - subsequent `maw hey` skips consent entirely
```

**Phase 1 simplification**: client doesn't poll. After requesting, it prints the request id + tells the user to retry once the peer approves. Polling is Phase 2.

## Storage

### `~/.maw/trust.json`

```json
{
  "version": 1,
  "trust": {
    "neo→mawjs:hey": {
      "from": "neo",
      "to": "mawjs",
      "action": "hey",
      "approvedAt": "2026-04-19T08:00:00.000Z",
      "approvedBy": "human",
      "requestId": "abc-123"
    }
  }
}
```

Key format: `<from>→<to>:<action>`. Asymmetric — neo trusting mawjs for hey does NOT mean mawjs trusts neo. Both entries are written when consent is approved (peer writes its own; client writes its mirror via the response).

### `~/.maw/consent-pending/<id>.json`

```json
{
  "id": "01HXXX...",  // ULID for sortability
  "from": "neo",      // requesting oracle (node name)
  "to": "mawjs",      // target oracle (node name)
  "action": "hey",    // hey | team-invite | plugin-install
  "summary": "hey msg: \"hello mawjs\"",
  "pinHash": "sha256(pin)",  // never store plaintext
  "createdAt": "2026-04-19T08:00:00.000Z",
  "expiresAt": "2026-04-19T08:10:00.000Z",
  "status": "pending"  // pending | approved | rejected | expired
}
```

TTL: **10 minutes**. After expiry, the file lingers (audit trail) but `isPending()` returns false. Cleanup is lazy on `maw consent list`.

### Why hash the PIN?

A 6-char PIN from a 32-char alphabet = 30 bits. If we stored plaintext, anyone with read access to `~/.maw/consent-pending/` could approve themselves. SHA-256 of the PIN is sufficient — brute force a 30-bit space takes minutes; the 10-minute TTL bounds the window.

## API Surface

### Core (`src/core/consent/`)

```ts
// pin.ts
export function generatePin(): string  // delegates to pair/codes.ts generateCode()
export function hashPin(pin: string): string

// trust.ts
export function isTrusted(from: string, to: string, action: string): boolean
export function recordTrust(entry: TrustEntry): void
export function listTrust(): TrustEntry[]

// store.ts (consent-pending/)
export function writePending(req: PendingRequest): void
export function readPending(id: string): PendingRequest | null
export function listPending(): PendingRequest[]
export function updateStatus(id: string, status: Status): void

// request.ts (orchestration)
export interface ConsentRequest { from: string; to: string; action: string; summary: string; peerUrl: string }
export interface ConsentResult { ok: boolean; requestId?: string; pin?: string; error?: string; trusted?: boolean }
export async function requestConsent(req: ConsentRequest): Promise<ConsentResult>
export async function approveConsent(requestId: string, pin: string): Promise<{ ok: boolean; error?: string }>
```

### Federation HTTP (`src/api/consent.ts`)

```
POST /api/consent/request           — peer receives request, persists pending
GET  /api/consent/:id/status        — poll status
POST /api/consent/:id/approve       — local-only (loopback) approval with PIN
```

`/api/consent/request` is **unauthenticated** — consent is the auth. Request includes `from` (claimed identity) and `summary` (human-readable preview shown to approver). Approver verifies identity OUT OF BAND ("hey did you just try to message me?").

### CLI (`src/commands/plugins/consent/`)

```
maw consent                          — list pending (alias for `list`)
maw consent list                     — show pending requests
maw consent approve <id> <pin>       — approve and write trust
maw consent trust <peer> [action]    — pre-approve without round-trip (default action=hey)
maw consent untrust <peer> [action]  — revoke trust entry
```

## Integration Point — `maw hey`

In `cmdSend()` (src/commands/shared/comm-send.ts), top of function:

```ts
if (process.env.MAW_CONSENT === "1") {
  const { maybeGateConsent } = await import("../../core/consent/gate");
  const gated = await maybeGateConsent(query, message, config);
  if (gated.blocked) { process.exit(gated.exitCode ?? 1); }
}
```

The gate:
1. Resolves query → peer node name (uses existing `resolveTarget`).
2. If local or self-node → never gates (skip entirely).
3. If `isTrusted(myNode, peerNode, "hey")` → skip.
4. Otherwise → call `requestConsent`, print PIN + id, exit 0 with message NOT delivered.

`/api/send` (server-to-server) is also gated — same check, returns HTTP 428 ("Precondition Required") with body `{ ok: false, consent: { id, action: "hey" } }` when consent is needed.

## Why opt-in (MAW_CONSENT=1)?

- Existing users have established trust with their peers; turning this on by default would break every `maw hey` until trust is bootstrapped.
- We need to dogfood Phase 1 in a controlled way (Nat + 1-2 peer oracles) before flipping the default.
- Phase 2 will introduce trust bootstrapping during `maw pair` (when you pair, you implicitly trust for hey) which makes default-on viable.

## Tests (Phase 1)

- `core/consent/pin.test.ts` — generatePin shape, hashPin determinism
- `core/consent/trust.test.ts` — round-trip write/read, isTrusted with multi-action scope
- `core/consent/store.test.ts` — pending file lifecycle, expiry, atomic write
- `core/consent/request.test.ts` — requestConsent → approveConsent round-trip with mock fetch
- `cli/consent-plugin.test.ts` — CLI surface (list/approve/trust)
- Existing `comm-send.test.ts` (if present) extended for MAW_CONSENT=1 gate behavior

## Out of scope / open questions

1. **Multi-window targeting**: `maw hey neo:01-a:3` carries a window suffix. We trust the **node**, not the window — gate operates on resolved node name only.
2. **Plugin namespacing**: `maw hey plugin:foo "msg"` already routes through cmdSend at the top. We treat plugin sends as local (no gate) for Phase 1 — they don't cross the federation boundary.
3. **Replay protection**: a consent request is single-use (status flips to "approved"; trust entry is what matters going forward). The pending file becomes audit only.
4. **Trust expiry**: not in Phase 1. Trust is permanent until `maw consent untrust`.
5. **UI**: deferred to Phase 2 — Phase 1 is CLI-only.

## Why this matches #644

The AirDrop epic (#644) wants ONE primitive that gates 3 different surfaces. Phase 1 ships the primitive + first surface (`hey`). Phases 2/3 wire `team-invite` and `plugin-install` using the same `requestConsent`/`isTrusted` API — no rework. Action namespace (`hey` / `team-invite` / `plugin-install`) is the seam.
