# Peer handshake errors — loud by default (#565)

## Problem

Today `maw peers add w http://white.local:3456` silently succeeds when
DNS can't resolve `white.local`. The alias lands in `~/.maw/peers.json`
with `node: null`, `lastSeen: null` — and nothing on stderr. `maw peers
info w` then prints:

```json
{
  "alias": "w",
  "url": "http://white.local:3456",
  "node": null,
  "addedAt": "2026-04-18T22:10:00.000Z",
  "lastSeen": null
}
```

The user has no signal to distinguish:

- DNS failure (`ENOTFOUND` / `EAI_AGAIN`) — peer hostname doesn't resolve
- Peer down (`ECONNREFUSED`) — host resolves, nothing on port
- Timeout (`AbortError` after 2s) — host reachable, no response
- HTTP error (4xx/5xx from `/info`) — peer up, endpoint missing/broken
- TLS error (`CERT_HAS_EXPIRED`, self-signed) — https-only

Root cause: `resolveNode()` in `impl.ts:35–50` wraps a `fetch` in a
bare `try/catch { return null }`. Error identity is thrown away.
`cmdAdd()` stores `node: null` whether the user passed `--node` or the
probe failed — the two states are indistinguishable from the store.

Aligned with #565's "better member selection — surface ambiguity
instead of silently picking" seam: don't hide the failure mode.

## Scope

Minimal. Do NOT rewrite the federation transport or change the peers
storage schema in a breaking way. Only:

1. Classify probe errors into a small enum.
2. Persist the last error on the peer record (optional, opt-in field).
3. Print the error LOUDLY on `peers add` (stderr, colored, with hint).
4. Surface the error in `peers info` output.
5. Add `maw peers probe <alias>` to re-run the handshake on demand.

## Error classification

One helper, `classifyProbeError(err, url): ProbeError`, returning:

| `code`          | Trigger                                              | Hint                                                               |
|-----------------|------------------------------------------------------|--------------------------------------------------------------------|
| `DNS`           | `err.cause.code` ∈ `ENOTFOUND`, `EAI_AGAIN`          | "Host does not resolve. Check /etc/hosts, DNS, or VPN."            |
| `REFUSED`       | `err.cause.code === "ECONNREFUSED"`                  | "Host resolves but port is closed. Is the peer process running?"   |
| `TIMEOUT`       | `err.name === "AbortError"` or `ETIMEDOUT`           | "Peer did not respond within 2s. Network path may be blocked."     |
| `TLS`           | `err.cause.code` matches `^CERT_`, `SELF_SIGNED_...` | "TLS handshake failed. Check cert validity / chain."               |
| `HTTP_4XX`      | `res.ok === false && res.status >= 400 && < 500`    | "Peer responded with {status}. /info endpoint may be missing."     |
| `HTTP_5XX`      | `res.ok === false && res.status >= 500`             | "Peer returned {status}. Server-side fault."                       |
| `BAD_BODY`      | `/info` returned ok but body not `{ node|name }`    | "/info responded but body shape unexpected."                       |
| `UNKNOWN`       | Any other thrown error                               | Message from `err.message`.                                        |

Node.js surfaces syscall codes via `err.cause.code` for `fetch`
failures (undici). The classifier inspects `err.cause?.code` first,
then `err.code`, then `err.name`, with a fallback to `UNKNOWN`.

## Output shape

### `peers add` — loud stderr block

When probe fails AND `--node` was not supplied:

```
added w → http://white.local:3456
⚠  peer handshake failed: DNS
   host: white.local:3456
   hint: Host does not resolve. Check /etc/hosts, DNS, or VPN.
   retry: maw peers probe w
```

The peer is still added (alias is useful even without node resolution),
but the error is no longer invisible. Colored `⚠` on stderr so it
survives piping stdout to `jq`.

If `--node` was supplied, probe failures still warn but the peer gets
the user-provided node value.

### `peers info` — include lastError if present

```json
{
  "alias": "w",
  "url": "http://white.local:3456",
  "node": null,
  "addedAt": "2026-04-18T22:10:00.000Z",
  "lastSeen": null,
  "lastError": {
    "code": "DNS",
    "message": "getaddrinfo ENOTFOUND white.local",
    "at": "2026-04-19T01:02:03.456Z"
  }
}
```

`lastError` is omitted from the JSON when absent (no field = never
failed). Stays opt-in; existing records with no error are unchanged.

### `peers probe <alias>` — re-run handshake

```
$ maw peers probe w
probing w → http://white.local:3456 ...
⚠  DNS — getaddrinfo ENOTFOUND white.local
   hint: Host does not resolve. Check /etc/hosts, DNS, or VPN.
```

On success, clears `lastError`, sets `lastSeen = now()`, updates
`node` if it changed. Exit code matches outcome (0 = reached peer,
1 = probe failed) so scripts can branch.

## Back-compat

- `peers.json` schema v1 unchanged. `lastError` is an optional field
  added to existing `Peer` records — readers that don't know about it
  keep working (unknown keys were never stripped).
- `resolveNode()` is kept as a thin wrapper for callers that only
  want `string | null`. The new `probePeer()` returns a richer
  `{ node, error }` shape. No existing call site is silently rerouted.
- Existing tests continue to pass — they mock DNS-failing URLs and
  expect `node: null`. That behavior is preserved; only the `lastError`
  side-channel is new.

## File budget

Current `impl.ts` is 119 LOC. Adding classifier (~30 LOC) + probe
wrapper (~25 LOC) + loud-format helper (~20 LOC) lands around 195 LOC
— inside the 200 LOC soft cap from CONTRIBUTING. If it creeps over,
split the classifier into `impl-probe.ts`.

## Test plan

New unit tests (peers.test.ts):

1. `classifyProbeError({cause:{code:"ENOTFOUND"}})` → `code: "DNS"`
2. `classifyProbeError({cause:{code:"ECONNREFUSED"}})` → `REFUSED`
3. `classifyProbeError({name:"AbortError"})` → `TIMEOUT`
4. `classifyProbeError({cause:{code:"CERT_HAS_EXPIRED"}})` → `TLS`
5. `classifyProbeError` on a fake `Response` with status 404 → `HTTP_4XX`
6. `classifyProbeError` on a fake `Response` with status 502 → `HTTP_5XX`
7. `cmdAdd` on a URL that refuses connections persists `lastError.code`
   (use `http://127.0.0.1:1` — port 1 is reliably closed on CI)
8. `cmdProbe` on a valid mock fetch clears `lastError` and sets `lastSeen`
9. `peers info` output (dispatcher) includes `lastError` field when set
10. `peers add` dispatcher with probe failure warns on stderr AND still
    returns `ok: true` (peer is added)

## Out of scope

- Automatic background probing / healthcheck — user runs `probe` explicitly.
- Probing on every `peers list` — O(N) network on a read verb is wrong.
- Changing `maw hey` routing based on `lastError` — separate PR, needs design.
- IPv6-specific classification (`EHOSTUNREACH` vs `ENETUNREACH`) —
  both land in `UNKNOWN` for now; cheap to add later.

## References

- Issue #565 — "better member selection, surfaces ambiguity instead of silently picking"
- [`pair-code.md`](./pair-code.md) — sibling `#565` facet: `maw pair` 6-char ephemeral pairing (shipped #573)
- `src/commands/plugins/peers/impl.ts:35–50` — existing silent `resolveNode`
- `src/commands/plugins/peers/store.ts:30–35` — `Peer` interface
- Memory: `project_neo_federation_ambiguity.md` — drove the seam
