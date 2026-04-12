# Federation API — v1 Reference

Public HTTP endpoints that federation-aware UI/lens clients depend on.

**Status**: v1 — stable contract, shape load-bearing for external consumers.
**Auth**: none (public discovery). Do not tighten `federationAuth()` over these without coordinating with every known consumer.
**Canonical consumer**: [`maw-ui`](https://github.com/Soul-Brews-Studio/maw-ui) federation lens — see [maw-ui#8](https://github.com/Soul-Brews-Studio/maw-ui/pull/8) for the first client to bind to this contract.

---

## The v1 quartet

Four endpoints cover everything a federation lens needs: identity, lineage, live messages, peer reachability. Every other federation endpoint is optional, deferred, or legacy.

| Endpoint | Handler | Purpose |
|---|---|---|
| [`GET /api/config`](#get-apiconfig) | [`src/api/config.ts:148`](../src/api/config.ts) | Node identity + full aggregated agents map + named peers — single call, no fan-out |
| [`GET /api/fleet-config`](#get-apifleet-config) | [`src/api/fleet.ts:8`](../src/api/fleet.ts) | Raw `fleet/*.json` contents (includes `budded_from` lineage) |
| [`GET /api/feed`](#get-apifeed) | [`src/api/feed.ts:18`](../src/api/feed.ts) | Live bounded event stream (messages, state changes) |
| [`GET /api/federation/status`](#get-apifederationstatus) | [`src/api/federation.ts:17`](../src/api/federation.ts) | Peer reachability + per-peer enrichment |

---

### `GET /api/config`

Masked view of the loaded `maw.config.json`. **This is the canonical entry point for lens clients** — it already aggregates `agents` across the whole mesh (local + named peers) server-side, so a reader gets the full picture in one call without walking peers.

**Query params**
- `?raw=1` — return the unmasked loaded config (local use only; `federationToken` still masked in the default view)

**Response shape**

```json
{
  "node": "oracle-world",
  "host": "local",
  "port": 3456,
  "ghqRoot": "/home/neo/Code/github.com",
  "oracleUrl": "http://localhost:47779",
  "namedPeers": [
    { "name": "mba",        "url": "http://10.20.0.3:3457" },
    { "name": "white",      "url": "http://10.20.0.7:3456" },
    { "name": "clinic-nat", "url": "http://10.20.0.1:3457" }
  ],
  "agents": {
    "mawjs-oracle": "local",
    "homekeeper":   "mba",
    "pulse":        "white",
    "neo":          "clinic-nat"
  },
  "federationToken": "2QHm••••••••••••",
  "commands": { "default": "claude --dangerously-skip-permissions --continue" },
  "sessions": {},
  "envMasked": {},
  "env": {},
  "peers": []
}
```

**Load-bearing fields** (lens clients depend on these being present):
- `node` — string, the local node's name
- `agents` — `Record<string, string>` mapping `agentName → nodeName` for every agent visible in the mesh
- `namedPeers` — `Array<{ name, url }>`

---

### `GET /api/fleet-config`

Raw `fleet/*.json` file contents. The lens uses this for **lineage** — specifically the `budded_from` field that lets clients compute `budded_children` by inverting the parent map client-side.

**Response shape**

```json
{
  "configs": [
    {
      "name": "101-mawjs",
      "windows": [{ "name": "mawjs-oracle", "repo": "Soul-Brews-Studio/mawjs-oracle" }],
      "sync_peers": ["boonkeeper"]
    },
    {
      "name": "103-skills-cli",
      "windows": [{ "name": "skills-cli-oracle", "repo": "Soul-Brews-Studio/skills-cli-oracle" }],
      "sync_peers": ["mawjs"],
      "budded_from": "mawjs",
      "budded_at": "2026-04-10T03:50:00.000Z"
    }
  ]
}
```

**Load-bearing fields**:
- `configs[].name` — session slot (e.g. `"101-mawjs"`)
- `configs[].windows[].name` — agent name (e.g. `"mawjs-oracle"`)
- `configs[].budded_from` — optional, parent agent name if this oracle was budded from another

---

### `GET /api/feed`

Live bounded event stream. In-memory ring buffer, most recent events first. Filter `event === "MessageSend"` for chat-like messages.

**Query params**
- `?limit=N` — max 200, default from `cfgLimit("feedDefault")`
- `?oracle=<name>` — filter to a single oracle

**Response shape**

```json
{
  "events": [
    {
      "timestamp": "2026-04-11T14:15:28.961Z",
      "oracle": "mawjs-view",
      "host": "oracle-world",
      "event": "MessageSend",
      "project": "",
      "sessionId": "",
      "message": "…",
      "ts": 1775916928954
    }
  ],
  "total": 1,
  "active_oracles": ["mawjs-view"]
}
```

**Load-bearing fields**:
- `events[].event` — string kind (e.g. `"MessageSend"`, `"Notification"`)
- `events[].oracle` — oracle name
- `events[].ts` — unix millis, monotonic
- `active_oracles` — oracles with events in the last 5 minutes

---

### `GET /api/federation/status`

Peer reachability and latency. Used by v1.1 UX indicators; v1 lens does not wire it yet but the shape is stable.

**Response shape**

```json
{
  "localUrl": "http://localhost:3456",
  "peers": [
    { "url": "http://10.20.0.3:3457", "reachable": true, "latency": 200 },
    { "url": "http://10.20.0.7:3456", "reachable": true, "latency": 366 },
    { "url": "http://10.20.0.1:3457", "reachable": true, "latency":  94 }
  ],
  "totalPeers": 3,
  "reachablePeers": 3
}
```

When a peer is running commit [`9a0546d`](https://github.com/Soul-Brews-Studio/maw-js/commit/9a0546d) or later, peer entries gain optional `node` and `agents` fields — lens clients should handle both shapes gracefully.

---

## Deferred / non-v1

These endpoints work but **are not part of the v1 lens contract**. They may be absent on stale processes (see #249 for the pm2 case on `oracle-world`).

| Endpoint | Why deferred | What to use instead |
|---|---|---|
| `GET /api/identity` | Redundant with `/api/config.node` for v1 | `/api/config` |
| `GET /api/fleet` | `fleet-config` is the same data in a simpler shape | `/api/fleet-config` |
| `GET /api/messages` | `/api/feed` is the live-bounded form v1 needs | `/api/feed?limit=200` |
| `GET /api/plugins` | Optional; lens should degrade gracefully if absent | — |

## What NOT to build in a v1 lens

Learned the hard way on 2026-04-11 while scoping the first lens:

1. **No server-side aggregator endpoint** (`/api/federation/discover` was proposed and then walked back). `/api/config` already returns the aggregated `agents` map — nothing to aggregate on the server.
2. **No source-picker + localStorage + dropdown first**. Start with a single `?host=` query param and a hard-coded default. The walk-back from "source-picker + dropdown + localStorage + multi-source merge + badge + new aggregator endpoint" to "just point `useFederationData` at `/api/config`" is the reference shrink (see [#248](https://github.com/Soul-Brews-Studio/maw-js/issues/248) comments and `ψ/memory/feedback_less_is_more_ui.md` in the mawjs-oracle vault).
3. **No N+1 peer walk**. If a future client thinks it needs to call `/api/fleet-config` against every peer URL from `/api/federation/status`, it's rebuilding what `/api/config.agents` already ships in one call.

## Stability guarantees

- **Shape is load-bearing** for the fields marked above. Adding new optional fields is fine; renaming or removing load-bearing fields is a breaking change for every lens in the mesh.
- **Auth is `none`** on all four endpoints. They predate `federationAuth()` and tightening them would break every current lens without a coordinated rollout.
- **Ordering** (arrays): `namedPeers`, `agents` (object), `peers`, `configs` — treat as sets, not sequences. Sorting is client-side.
- **Error shape**: handlers return `200 + { error }` on recoverable problems (e.g. `/api/fleet-config` on a missing dir), not HTTP 5xx. Clients should check for `error` on the response body.

## Related

- [maw-ui#8](https://github.com/Soul-Brews-Studio/maw-ui/pull/8) — first v1 lens client, drift map in PR body
- [maw-ui#9](https://github.com/Soul-Brews-Studio/maw-ui/pull/9) — v1.1 identity badge using `/api/config.node`
- [maw-ui#10](https://github.com/Soul-Brews-Studio/maw-ui/pull/10) — CI workflow that prevents "fresh clone can't build" regressions on the lens side
- [#249](https://github.com/Soul-Brews-Studio/maw-js/issues/249) — stale pm2 on `oracle-world` causing some deferred endpoints to 404
- `ψ/memory/feedback_less_is_more_ui.md` (mawjs-oracle vault) — the "ground BEFORE proposing" rule that scoped v1 down to this quartet
