# Pair-code federation — `maw pair`

Ephemeral 6-character codes for server-to-server federation handshake.
Replaces the manual `federationToken` copy-paste flow with a 120-second
single-use code. Ships in `maw pair` (plugin) and `POST /api/pair/*`
(HTTP surface). See [#565](https://github.com/Soul-Brews-Studio/maw-js/issues/565)
for the original proposal and [#573](https://github.com/Soul-Brews-Studio/maw-js/pull/574)
for the delivery PR.

## Two-party flow

Recipient (`A`) mints a code; initiator (`B`) posts the code back with
its own identity. On success both sides write reciprocal aliases into
`~/.maw/peers.json`.

```
┌───────────── A (recipient) ─────────────┐          ┌────── B (initiator) ──────┐
│  $ maw pair generate                    │          │                           │
│  🤝 pair code: W4K-7F3  (expires 120s)  │          │                           │
│     listening on http://localhost:3456  │          │                           │
│     …polls /api/pair/W4K7F3/status…     │          │                           │
│                                         │  code    │  $ maw pair \             │
│                                         │ ←──────  │      http://A:3456 W4K-7F3│
│  /api/pair/W4K7F3 ← POST {node,url}     │ ───────→ │                           │
│  ✅ paired with node-b at http://B:3456 │          │  ✅ paired: node-b ↔ node-a│
└─────────────────────────────────────────┘          └───────────────────────────┘
```

Both sides end with an entry in `peers.json`:

- A: `peers["node-b"] = { url: "http://B:3456", node: "node-b", … }`
- B: `peers["node-a"] = { url: "http://A:3456", node: "node-a", … }`

`cmdAdd()` auto-probes `/info` as part of the write, so reciprocal
`lastSeen` is populated immediately — no separate `maw peers probe` run
needed.

## CLI

```bash
# Recipient — mint code and poll until accepted
maw pair generate                 # 120s TTL (default)
maw pair generate --expires 300   # 5..3600s range

# Initiator — post code + identity to recipient's URL
maw pair http://recipient:3456 W4K-7F3
maw pair http://recipient:3456 w4k7f3   # hyphen + case optional
```

The initiator always supplies the recipient's URL explicitly. LAN
auto-discovery (mDNS / `.local`) is deliberately not wired — it needs
`avahi-daemon` on Linux and platform-specific code; the URL-first shape
works identically everywhere.

## HTTP surface (`/api/pair/*`)

| Method | Path                       | Purpose                                                      |
|--------|----------------------------|--------------------------------------------------------------|
| POST   | `/api/pair/generate`       | Mint a code, start the TTL. Body: `{ ttlMs? }`.              |
| GET    | `/api/pair/:code/probe`    | Is the code live? `200` / `404 not_found` / `410 expired`.   |
| POST   | `/api/pair/:code`          | Acceptor submits `{ node, url }`. Consumes the code.         |
| GET    | `/api/pair/:code/status`   | Recipient polls. `{ consumed, remoteNode, remoteUrl }`.      |

`POST /api/pair/:code` is the handshake endpoint — it consumes the code
atomically (single-use), writes the acceptor into peers.json via
`cmdAdd()`, and returns the recipient's `{ node, url, federationToken }`
so the acceptor can write the reciprocal alias.

## Code format

- 6 characters, rendered `XXX-XXX` for readability.
- Alphabet: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — 32 chars, confusing
  glyphs (`I`/`O`/`0`/`1`/`l`) removed. 30 bits of entropy per code.
- Generation: `crypto.getRandomValues()` (WebCrypto) — cryptographically
  random, not `Math.random()`.
- Input normalization strips hyphens and whitespace, uppercases
  everything before comparison, so `W4K-7F3`, `w4k7f3`, `W4K 7F3` all
  match.

## TTL, single-use, security notes

- Default TTL is 120 seconds (configurable `--expires 5..3600`). After
  expiry the code rejects with `410 expired`.
- Codes are single-use: the first successful `POST /api/pair/:code`
  flips the `consumed` flag atomically. A second POST returns
  `410 consumed`.
- No HMAC, no rate limit — the 30-bit code itself authenticates the
  single exchange. At 10 guesses/sec an attacker gets ~1 in ~1M chance
  per code; the 120s window keeps the brute-force surface small.
- Plain-HTTP warning: the initiator prints a stderr warning when
  pairing to a non-loopback `http://` URL — TLS is recommended for
  cross-network pairing.
- The server MUST have `federationToken` set in `maw.config.json` for
  peer exec / workspace auth *after* pairing — `maw pair` hands off a
  fresh token in the response, but durable auth lives in config.

## Error cases

| Situation                                 | HTTP | Initiator sees                                         |
|-------------------------------------------|------|--------------------------------------------------------|
| Bad code shape (length ≠ 6, bad char)     | 400  | `invalid code shape: W4K-***`                          |
| Code not found (typo, different server)   | 404  | `handshake failed: not_found (check spelling…)`        |
| Code expired (TTL elapsed)                | 410  | `handshake failed: expired (code expired or consumed)` |
| Code already consumed                     | 410  | `handshake failed: consumed (code expired or consumed)`|
| Network unreachable / wrong URL           | —    | `handshake failed: network_error (network unreachable…)`|

## Reading the code

- `src/commands/plugins/pair/codes.ts` — alphabet, `generateCode()`,
  `register / lookup / consume`, `normalize / pretty / redact`, in-memory
  TTL `Map<string, PairEntry>`.
- `src/commands/plugins/pair/impl.ts` — `pairGenerate` (recipient
  polling loop) and `pairAccept` (initiator client), both ending in
  `cmdAdd()` for reciprocal peer write.
- `src/commands/plugins/pair/handshake.ts` — the initiator-side
  `postHandshake()` HTTP client with a 5s timeout.
- `src/api/pair.ts` — Elysia route table for `/api/pair/*`, mounted in
  `src/api/index.ts`.

## Related

- [`docker-testing.md`](./docker-testing.md) — 2-container federation
  harness used for round-trip integration testing.
- [`peer-handshake-errors.md`](./peer-handshake-errors.md) — loud
  probe-failure reporting on `maw peers add` (#565 facet 1).
