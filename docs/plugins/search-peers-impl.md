# Search-peers — Shape A implementation (#631)

Status: IMPLEMENTATION — companion to `marketplace-rfc.md` (Shape A).
Tracking issue: [#631](https://github.com/Soul-Brews-Studio/maw-js/issues/631)
Date: 2026-04-19
Owner: search-peers-shipper (team go-5-r7-0419)

This doc pins the algorithm, timeouts, data shape, and error matrix for the
first concrete Shape A delivery. The RFC picked the shape; this doc picks
the nuts and bolts so a reviewer can check the code against a single spec.

## Scope (this PR only)

1. New server endpoint — `GET /api/plugin/list-manifest` — advertises this
   node's installed plugins. Discoverable subset of the `plugin.json` data
   already known to `discoverPackages()`. No new secrets, no new capabilities.
2. New client module — `src/commands/plugins/plugin/search-peers.ts` —
   exports `searchPeers(query, opts)`. Fans out across
   `getPeers()`, collects manifests, merges/dedupes, returns a typed result.
3. CLI wire — `runSearchCmd` in `src/commands/plugins/plugin/index.ts` picks
   up three flags:
   - `--peers` — also query peers in addition to registry.
   - `--peers-only` — skip the registry, query peers only.
   - `--peer <name>` — query exactly one peer by `namedPeers[].name`.

Out of scope (deferred, follow-up PRs):

- `--broad` / cross-node transitive walk via `oracle scan --remote`.
- `maw plugin install <name>@<peer>` (tarball fetch from peer).
- Warn-loud behavior when peer plugin sha256 disagrees with `plugins.lock`.

## Data shape

Reuses `RegistryManifest` spirit but with fewer guarantees — a peer manifest
is **advisory only** and not a trust root (`plugins.lock` keeps its role).

```ts
interface PeerPluginEntry {
  name: string;            // plugin.json name
  version: string;         // plugin.json version
  summary?: string;        // plugin.json description (optional)
  author?: string;         // plugin.json author (optional)
  sha256?: string | null;  // artifact sha256 if built, null if unbuilt, omit if legacy
}

interface PeerManifestResponse {
  schemaVersion: 1;
  node: string;            // loadConfig().node ?? "unknown"
  pluginCount: number;     // convenience for UI
  plugins: PeerPluginEntry[];
}
```

`PluginSearchResult` returned by `searchPeers()`:

```ts
interface PluginSearchHit {
  name: string;
  version: string;
  summary?: string;
  author?: string;
  peerName?: string;       // from namedPeers if matched
  peerUrl: string;         // always populated
  peerNode?: string;       // from PeerManifestResponse.node
  sha256?: string | null;
}

interface PeerError {
  peerUrl: string;
  peerName?: string;
  reason: "timeout" | "unreachable" | "bad-response" | "http-error";
  detail?: string;
}

interface SearchPeersResult {
  hits: PluginSearchHit[];
  queried: number;         // peers attempted
  responded: number;       // peers that returned a valid manifest
  errors: PeerError[];     // one per peer that failed
  elapsedMs: number;
}
```

## Algorithm

```
searchPeers(query, opts):
  1. peers = opts.peer ? [lookup peer by namedPeer.name] : getPeers()
     - if --peer and name not found → throw "unknown peer <name>"
  2. fetchAll = peers.map(url =>
       withTimeout(perPeerMs, fetchPeerManifest(url)))
  3. results = await Promise.all(fetchAll) capped by totalMs
  4. merge:
       for each (url, manifest) where manifest.ok:
         for each plugin in manifest.plugins:
           if plugin.name.toLowerCase().includes(q)
              || plugin.summary?.toLowerCase().includes(q):
             push hit with peerUrl, peerName (from namedPeers lookup), peerNode
  5. dedupe: key = `${hit.name}@${hit.version}@${hit.peerUrl}` — first wins
     (we keep one hit per (plugin, version, peer); same plugin from two peers
      intentionally surfaces twice, because `install <name>@<peer>` needs both)
  6. sort: by name asc, then version asc
  7. return SearchPeersResult
```

`fetchPeerManifest(url)`:

- Per-peer cache at `~/.maw/peer-manifest-cache/<urlsafe>.json` (5-min TTL,
  mirrors `registry-fetch.ts:CACHE_TTL_MS`).
- Cache hit → return cached, no network.
- Cache miss/stale → `curlFetch(${url}/api/plugin/list-manifest, {timeout: perPeerMs})`.
- On success → write cache, return data.
- On failure → if cache present (stale), return cached + soft-warn; else
  return `PeerError` to caller (caller aggregates into `errors[]`, not a throw).

### urlsafe encoding

Cache filename uses `encodeURIComponent(url).replace(/%/g, '_')` — keeps it
readable (`http:__white.fleet.local:3456.json`) without shell-collision risk.

## Timeouts

| Setting          | Value   | Why |
| ---------------- | ------- | --- |
| per-peer fetch   | 2000 ms | matches federation default in `getFederationStatus()` flow; peers are usually LAN/WG |
| total budget     | 4000 ms | hard cap so `maw plugin search --peers` never hangs a shell |
| cache TTL        | 5 min   | same as registry cache — peers don't ship plugins minute-by-minute |

Both configurable at call time via `opts.perPeerMs` / `opts.totalMs` so tests
can run at 50 ms / 100 ms without racing.

## Error matrix

| Condition                              | `searchPeers` returns                                           | stderr |
| -------------------------------------- | --------------------------------------------------------------- | ------ |
| peer offline (curl connect refused)    | `errors[]` entry `reason: "unreachable"`                        | no     |
| peer slow past per-peer budget         | `errors[]` entry `reason: "timeout"`                            | no     |
| peer 404 (old version, no endpoint)    | `errors[]` entry `reason: "http-error"`, detail includes status | no     |
| peer 500                               | `errors[]` entry `reason: "http-error"`, detail includes status | no     |
| peer returns non-JSON / wrong schema   | `errors[]` entry `reason: "bad-response"`                       | no     |
| `--peer <name>` resolves to 0 peers    | throws `"unknown peer '<name>'"`                                | —      |
| `getPeers()` returns `[]`, no `--peer` | `hits: [], queried: 0, responded: 0`                            | no     |
| total budget exhausted before any peer | remaining peers marked `"timeout"` in `errors[]`                | no     |

The CLI wrapper prints a summary line (`N queried, M responded in Xs`) like
the RFC mockup. Individual peer errors are shown inline in `--verbose`, one
per line, dimmed — never as process failure.

## CLI behavior

```
maw plugin search <query>                      # registry only (unchanged)
maw plugin search <query> --peers              # registry + peers
maw plugin search <query> --peers-only         # peers, skip registry
maw plugin search <query> --peer <name>        # one peer by namedPeer.name
```

Combining `--peers-only` with `--peer` is allowed (`--peer` wins — single-peer
mode). Combining `--peers` with `--peer` is allowed (treated as `--peer` only).

Output format (registry + peers):

```
registry (maw.soulbrews.studio):
  <name>@<version>  <summary>
  ...

peers (N queried, M responded in X.Xs):
  <name>@<version>  <summary>  @<peer>[(<node>)]
  ...
```

## Server endpoint

`GET /api/plugin/list-manifest` → `PeerManifestResponse` JSON.

Implementation:

```ts
// src/api/plugin-list-manifest.ts
export const pluginListManifestApi = new Elysia().get("/plugin/list-manifest", () => {
  const plugins = discoverPackages().map(p => {
    const m = p.manifest;
    const entry: PeerPluginEntry = {
      name: m.name,
      version: m.version,
      summary: m.description,
      author: m.author,
      sha256: m.artifact?.sha256 ?? undefined,
    };
    return entry;
  });
  return {
    schemaVersion: 1 as const,
    node: loadConfig().node ?? "unknown",
    pluginCount: plugins.length,
    plugins,
  };
});
```

Mounted in `src/api/index.ts` alongside the existing pluginsRouter. Guarded
by the same `federationAuth` HMAC middleware as every other `/api/*` route.

## Tests

### Unit (`search-peers.test.ts`)

- Empty peer list → `hits: [], queried: 0`.
- Single peer with 3 plugins, query matches 1 → 1 hit with peerUrl.
- Two peers, same plugin @same version → 2 hits (dedupe keeps per-peer).
- Per-peer timeout → `errors[]` entry, surviving peers still in `hits`.
- `--peer <unknown>` → throws.
- Cache freshness — second call with same peers returns from cache (no fetch).
- Bad schema (missing `plugins[]`) → `bad-response`.

All fetches injected — no real HTTP. Follows the `SymmetricDeps` pattern
already used in `getFederationStatusSymmetric` so we don't hit the
`mock.module` process-global issue Bloom flagged in federation-audit.

### Integration (`test/integration/search-peers-2port.test.ts`)

- `Bun.serve()` two HTTP servers on OS-assigned ports, each mimicking
  `GET /api/plugin/list-manifest` with a distinct node identity + plugin set.
- Call `searchPeers("example", { peers, fetch: rawFetch })` and assert the
  merge: two hits, one per peer, peerNode populated from manifest.
- Also covers http-error classification and cache-fallback (prime peer,
  stop the server, assert second call still responds from on-disk cache).

Lives under `test/integration/` rather than next to the unit tests because
`mock.module(..., curl-fetch)` calls in sibling plugin tests
(`hey-plugin.test.ts`, `ping.test.ts`) pollute Bun's process-global
module registry — co-located the integration test would hijack real
HTTP and return `{ok: false}` (same class of bug Bloom flagged in
PR #398 federation-audit).

Skipped when `MAW_SKIP_INTEGRATION=1` is set (CI shards that can't bind
ports, same pattern used elsewhere in the tree).

## Risks / open questions deferred to follow-up

1. Peer auth — today `federationAuth` is a HMAC middleware; the endpoint
   sits behind it like every other `/api/*` route. If a follower wants
   "anyone can read the manifest" we'd need explicit opt-in, but by default
   search-peers is same-trust as every other federation primitive.
2. `plugins.lock` disagreement — if peer advertises `name@1.0.0` with a
   different `sha256` than the local lock, we currently surface both
   peacefully. Loud-warn belongs in `install <name>@<peer>`, not in search.
3. Scale — fanout is O(peers). Cache + 4s total budget keeps it bounded.
   A transitive `--broad` mode would need a proper cycle-breaker; out of scope.

## Demo (what "done" looks like)

```
# Node A (port 3456) and Node B (port 3457) both running maw serve,
# each with at least one plugin installed.
# Node A config lists Node B as a namedPeer.

$ maw plugin search example --peers
registry (…):
  (no hits)

peers (1 queried, 1 responded in 0.1s):
  example-plugin@1.0.0  hello from example  @two
```

Ship gate:

- `bun run test:all` green.
- Integration demo (above) runs locally without network.
- PR title: `feat(plugin): ship search-peers federated search (#631)`.
