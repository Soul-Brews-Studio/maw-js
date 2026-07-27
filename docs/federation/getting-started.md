# Federation — Getting Started

Connect maw nodes across machines. Send messages, sync agent registries, and monitor fleet health.

## Prerequisites

- maw-js installed on each machine (`bun add -g maw-js`)
- Network connectivity between machines (LAN, WireGuard, or public IP)
- tmux running on each machine

## 1. Start the server

```bash
maw serve
# → maw serve → http://localhost:3456
```

The server must be running to receive federation messages. Use pm2 for persistence:

```bash
pm2 start "maw serve" --name maw-server
pm2 save
```

## 2. Set your node identity

Edit `~/.config/maw/maw.config.json`:

```json
{
  "node": "m5",
  "oracle": "mawjs"
}
```

- `node` — unique name for this machine (e.g., `white`, `mba`, `m5`)
- `oracle` — the oracle family this node belongs to
- `hostAliases` — optional array of other names this same machine answers to for `node:agent` routing, e.g. `"hostAliases": ["mba"]` if this host is also addressed as `mba` elsewhere. Only needed if a `node:agent` send names this host by more than one identity; an undeclared, unrecognized node fails with an error instead of guessing.

Verify:

```bash
curl -s http://localhost:3456/api/identity | jq '{node, oracle, version}'
```

## 3. Add peers

Add other machines as named peers:

```json
{
  "node": "m5",
  "namedPeers": [
    { "name": "white", "url": "http://white.local:3456" },
    { "name": "mba", "url": "http://mba.wg:3457" }
  ]
}
```

Check connectivity:

```bash
maw federation status
```

Output shows each peer's reachability, latency, and agent count:

```
Federation Status  3 nodes (1 local + 2 peers)

  ●  m5 (local)     online  7 agents
     http://localhost:3456
  ●  white           online  12 agents  3ms
     http://white.local:3456
  ○  mba             offline
     http://mba.wg:3457
```

## 4. Secure with a token

Without a token, any machine on your network can send messages. Add a shared secret (min 16 chars):

```json
{
  "federationToken": "your-secret-token-here-min-16"
}
```

Set the **same token** on every peer. Requests are signed with HMAC-SHA256 (±5 min clock window).

## 5. Send messages

```bash
# To an agent on another machine
maw hey white:neo "deploy complete, tests green"

# To a local agent (use your node name)
maw hey m5:mawjs "local test"

# To a team
maw hey team:swarm "all agents: status report"
```

Messages arrive as `send-keys` into the target's tmux pane.

## 6. Sync agent registries

Discover which agents exist across all peers:

```bash
maw federation sync --dry-run   # preview what would sync
maw federation sync             # apply: populate config.agents with peer agents
```

After sync, `config.agents` maps agent names to their home nodes:

```json
{
  "agents": {
    "neo-oracle": "white",
    "homekeeper-oracle": "mba",
    "mawjs-oracle": "m5"
  }
}
```

## 7. Verify bidirectional connectivity

```bash
maw federation --verify
```

Tests both directions for every peer pair. Reports asymmetric reachability (A can reach B but not reverse).

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/identity` | GET | Node name, version, agents, pubkey |
| `/api/federation/status` | GET | Peer reachability + latency |
| `/api/send` | POST | Deliver message to agent (`{target, text}`) |
| `/api/config` | GET | Full aggregated agents map |
| `/api/probe` | POST | Health check (matches /api/send path) |

## Auth Versions

| Version | Header | Payload |
|---------|--------|---------|
| v1 | `X-Maw-Auth` | `HMAC(token, "METHOD:PATH:TIMESTAMP")` |
| v2 | `X-Maw-Auth` + `X-Maw-Auth-Version: v2` | Adds `:BODY_SHA256` |
| v3 | v2 + `X-Maw-From` + `X-Maw-Signature-V3` | Adds per-peer ED25519 pubkey signing |

v2 is the default. v3 adds TOFU pubkey pinning for zero-config identity.

## Troubleshooting

**"No peers configured"** — Add `namedPeers` to `maw.config.json`.

**"Peer offline"** — Check if `maw serve` is running on the peer. Test with `curl http://peer:3456/api/identity`.

**Clock skew warning** — Federation uses ±5 min clock tolerance. If peers have >3 min skew, auth will intermittently fail. Sync clocks with NTP.

**"bare-name target removed"** — Since #759, bare names like `maw hey neo "msg"` are rejected. Use `maw hey white:neo "msg"` (node:agent format).

## Next Steps

- [Peer Identity (ADR-0001)](./0001-peer-identity.md) — how identity and pubkey signing work
- [Peer Handshake Errors](./peer-handshake-errors.md) — diagnosing connection failures
- [Stale Peer Diagnosis](./stale-peer-diagnosis.md) — handling peers that go offline
- [Federation API Reference](../federation.md) — full v1 endpoint documentation
