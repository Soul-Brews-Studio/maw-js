# Shape A — end-to-end demo (the marketplace walkthrough)

Status: DEMO — a concrete, copy-pasteable walkthrough of the federated
plugin marketplace (Shape A) from `marketplace-rfc.md`. Works against a
fresh `main` as of 2026-04-19 unless a step is marked **(pending)**.

Companion docs:

- [marketplace-rfc.md](./marketplace-rfc.md) — why federated over central.
- [dogfood-protocol.md](./dogfood-protocol.md) — the repeatable test matrix.
- [at-peer-install.md](./at-peer-install.md) — `<name>@<peer>` design notes.

If you just want to see the shape work, run the seven steps below in
order. Each step shows the exact command, an expected output snippet,
and a one-paragraph note on what happened underneath.

---

## Setup — two `maw serve` instances on different ports

Shape A is about *peer-to-peer* discovery; it needs two oracles. For
a single-laptop demo we run two API servers against separate
`~/.maw` homes so their plugin stores don't collide.

```bash
# Terminal 1 — "host" oracle on :3456
MAW_HOME=/tmp/shape-a-host maw serve 3456

# Terminal 2 — "alice" oracle on :3457
MAW_HOME=/tmp/shape-a-alice maw serve 3457
```

Seed alice with a plugin to advertise:

```bash
MAW_HOME=/tmp/shape-a-alice maw plugin init ping --ts
MAW_HOME=/tmp/shape-a-alice maw plugin build ./ping
MAW_HOME=/tmp/shape-a-alice maw plugin install ./ping-0.1.0.tgz --pin
```

Give alice a display name so step 4 has something to show:

```bash
MAW_HOME=/tmp/shape-a-alice maw oracle set-nickname alice "Alice Oracle"
```

> Prefer a cross-host setup? Replace `localhost:3457` with alice's real
> URL (LAN IP, tunnel, whatever) — everything below works unchanged.
> See `dogfood-protocol.md` for Docker / two-node variants.

---

## Step 1 — register alice as a peer

```bash
maw peers add alice http://localhost:3457
```

Expected:

```
added alice → http://localhost:3457 (alice)
```

Then confirm the handshake landed:

```bash
maw peers probe alice
```

```
probing alice → http://localhost:3457 ...
✓ reached alice (alice)
```

**What just happened.** `peers add` writes an entry to
`~/.maw/peers.json` and immediately probes `GET /info` on the URL. The
probe classifies network/HTTP errors into `DNS | REFUSED | TIMEOUT |
HTTP_4XX | HTTP_5XX | TLS | BAD_BODY | UNKNOWN` and exits non-zero on
failure (exit codes 2–6) — so scripts can branch on it. If `probe`
reports `(offline)`, fix the transport here before moving on; every
later step assumes this handshake is green.

---

## Step 2 — federated search

```bash
maw plugin search ping --peers
```

Expected:

```
registry:
  (no hits)

peers (1 queried, 1 responded in 0.3s):
  ping@0.1.0    ping plugin — pong response  @alice
```

**What just happened.** The CLI ran the normal registry search *and*
fanned out to every peer in `~/.maw/peers.json` (or just the one
targeted by `--peer alice`). Each peer is asked for
`GET /api/plugin/list-manifest`. Results are merged, deduped by
`{name, version}`, and annotated with `@<peerName>`. Per-peer timeouts
default to 2 s with a total budget of 4 s; responses are cached at
`~/.maw/peer-manifest-cache/<urlsafe>.json` for 5 min (same TTL as
`registry-cache.json`). Offline peers surface in a trailing error line
with a classified `reason:` — they never crash the command.

---

## Step 3 — install via `<name>@<peer>`

```bash
maw plugin install ping@alice --pin
```

Expected:

```
→ alice (alice) advertises: ping@0.1.0 (sha256: 9a34bd7c1f0e…)
→ downloading http://localhost:3457/api/plugin/download/ping…
✓ ping@0.1.0 installed
  sdk: ^1.0.0 ✓ (maw 2.0.0-alpha.26)
  capabilities: (none)
  mode: installed (sha256:9a34bd7…)
  dir: ~/.maw/plugins/ping
try: maw ping
```

**What just happened.** `detectMode()` parsed `ping@alice` into
`{ kind: "peer", name: "ping", peer: "alice" }` (see
`install-source-detect.ts`). `resolvePeerInstall()` called `searchPeers`
scoped to alice, picked the single hit, and handed a
`downloadUrl + peerSha256` off to the existing `installFromUrl` →
`installFromTarball` pipeline. The download is streamed, extracted, and
its `manifest.artifact.path` hash is verified against `plugins.lock`
(added by `--pin` on first install). The peer-advertised sha256 is
cross-checked after install as a diagnostic — if it disagrees with the
actual artifact hash, the install aborts. `plugins.lock` is the trust
root; `@peer` is a *discovery* convenience, not a bypass.

---

## Step 4 — nickname propagation

```bash
maw peers probe alice
maw peers info alice
```

Expected (`info` is JSON):

```json
{
  "alias": "alice",
  "url": "http://localhost:3457",
  "node": "alice",
  "nickname": "Alice Oracle",
  "lastSeen": "2026-04-19T10:42:07.512Z",
  "capabilities": ["hey", "peek", "plugin.list-manifest"]
}
```

**What just happened.** Probe re-fetches alice's `/info` body, which
(post-#628) carries `{ node, version, schemaVersion, capabilities,
nickname }`. The caller merges the fresh `nickname` into its
`peers.json` record and it surfaces in every downstream UX — `peers
info`, `peers list`, and the peer-tagged search hit in Step 2 will
upgrade from `@alice` to `@alice (Alice Oracle)` as the display layer
catches up. `set-nickname` writes through to `~/.maw/oracle.json` and
triggers the `/info` refresh; no restart needed.

---

## Step 5 — consent gate on an untrusted peer **(pending #644 Phase 3)**

> The consent primitive shipped in alpha.26 (#644 Phase 1). Wiring
> it into `maw plugin install` for untrusted peer sources is Task #2
> / tracking issue #644 Phase 3 — **in progress at time of writing**.
> The snippet below is the target UX; Steps 1–4 above work on fresh
> `main` today, Steps 5–6 will activate once Phase 3 lands.

```bash
MAW_CONSENT=1 maw plugin install foo@alice
```

Expected:

```
→ alice advertises: foo@0.2.0 (sha256: 70ad31a9…)
✋ consent required — installing a plugin from an untrusted peer.

  request id: cns_01HYZ0…
  from:       alice
  action:     plugin-install
  artifact:   foo@0.2.0 (sha256: 70ad31a9…)

  approve with: maw consent approve cns_01HYZ0… <pin>

install aborted (awaiting approval).
```

**What just happened (target behaviour).** With `MAW_CONSENT=1` the
install pipeline checks `~/.maw/consent/trust.json` for an entry
matching `from:<myNode> → to:alice, action:plugin-install`. No entry →
a pending consent request is written to `~/.maw/consent/requests.json`
with a 6-digit PIN echoed on the peer side (out-of-band delivery per
#644). The install aborts with a non-zero exit. No network fetch, no
tarball on disk — the gate runs *before* the download path. Setting
`MAW_CONSENT=0` (or unset) preserves the current behaviour: `@peer`
installs rely on `plugins.lock` sha256 pinning alone.

---

## Step 6 — approve the request **(pending #644 Phase 3)**

```bash
maw consent approve cns_01HYZ0… 314159
```

Expected:

```
✅ approved cns_01HYZ0… — trust written for oracle-world → alice:plugin-install
```

Retry Step 5 with `MAW_CONSENT=1`:

```
→ alice advertises: foo@0.2.0 (sha256: 70ad31a9…)
✓ trust entry found — oracle-world → alice:plugin-install (approved 2026-04-19T…)
→ downloading http://localhost:3457/api/plugin/download/foo…
✓ foo@0.2.0 installed
  …
```

**What just happened.** `consent approve` validated the PIN,
promoted the pending request into a durable trust record, and cleared
the gate for subsequent `plugin-install` actions from alice. The
trust entry is scoped by `{from, to, action}` — approving `alice` for
`plugin-install` does *not* approve `alice` for `hey` or
`team-invite`. Pins in `plugins.lock` still apply; consent is an
*additional* gate on top of sha256 verification, not a replacement.

---

## Step 7 — pre-approve a peer without a pending request

No untrusted install in hand, but you already know you trust alice
for plugin installs? Skip the pending/approve cycle:

```bash
maw consent trust alice plugin-install
```

Expected:

```
✅ trust written: oracle-world → alice:plugin-install
```

Verify:

```bash
maw consent list-trust
```

```
from → to                action            approvedAt
oracle-world → alice     plugin-install    2026-04-19T10:47:03.119Z
```

**What just happened.** `consent trust` writes the same record that
`consent approve` would have, without needing a pending request.
Subsequent `MAW_CONSENT=1 maw plugin install <name>@alice` calls find
the trust entry and proceed straight to download + install. Revoke
with `maw consent untrust alice plugin-install`.

> Note on the task brief: the task description calls this
> `maw trust add alice plugin-install`. The shipped CLI uses
> `maw consent trust …` — trust is a sub-verb of the consent plugin
> (`src/commands/plugins/consent/`), not a sibling top-level command.

---

## Full seven-step recap

| # | Command                                              | Surface exercised                          |
|---|------------------------------------------------------|--------------------------------------------|
| 1 | `maw peers add alice http://localhost:3457` + probe  | peers CRUD + `/info` handshake             |
| 2 | `maw plugin search ping --peers`                     | `searchPeers` fanout + manifest cache      |
| 3 | `maw plugin install ping@alice --pin`                | `@peer` install pipeline + `plugins.lock`  |
| 4 | `maw peers probe alice`                              | nickname wire (#628 + #643)                |
| 5 | `MAW_CONSENT=1 maw plugin install foo@alice` *(pending #644 Phase 3)* | consent gate on untrusted install |
| 6 | `maw consent approve <id> <pin>`                     | PIN verify + trust write                   |
| 7 | `maw consent trust alice plugin-install`             | pre-approve without a pending request      |

If any step fails, fall back to the matrix in
[`dogfood-protocol.md`](./dogfood-protocol.md#common-failures-and-diagnosis)
— it maps symptoms to root causes (stale PM2, hostname mismatch,
pre-#631 peer, etc.).

---

## Scope

- **Is**: a seven-step demo that exercises every surface Shape A
  touches — peers, federated search, `@peer` install, nickname, consent.
- **Isn't**: a substitute for `marketplace-rfc.md` (the design) or
  `dogfood-protocol.md` (the test matrix). This doc is intentionally
  narrative; the others are spec / matrix.
- Steps 1–4 and 7 run against fresh `main` today (alpha.26). Steps 5–6
  activate once #644 Phase 3 wires the consent gate into
  `install-impl.ts`; until then they document the intended behaviour.
