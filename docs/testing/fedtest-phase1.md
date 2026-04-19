# fedtest harness — Phase 1 analysis

> Epic: [#655](https://github.com/Soul-Brews-Studio/maw-js/issues/655).
> Phase 1 ships the skeleton only: a backend interface, two backends, a
> scenario type, a runner, and one canary scenario. No CI wiring, no
> Phase-2 scenarios.

## Goal

Two backends — **emulated** (fast, in-process) and **docker** (slow, real
network) — that expose **the same `BaseFederationBackend` interface**, so
every scenario can run against either without branching. Phase 1 proves
the contract with a single canary scenario (`01-handshake`) that passes
on both.

## The contract

```ts
// test/fedtest/backend.ts
export interface PeerHandle {
  /** Base URL other peers (or the test) can hit. */
  url: string;
  /** Peer's self-reported node identity (matches /info body.node). */
  node: string;
}

export interface SetUpOpts {
  peers: number;           // how many peers to spin up
  ports?: number[];        // optional fixed ports; otherwise ephemeral
}

export interface BaseFederationBackend {
  readonly name: "emulated" | "docker";
  setUp(opts: SetUpOpts): Promise<PeerHandle[]>;
  teardown(): Promise<void>;
}
```

Phase 1 intentionally keeps `PeerHandle` small — just `url` + `node`. The
richer surface in #655's sketch (`installPlugin`, `setSlow`, `setOffline`,
`spoofSha`, `spoofSource`) lands in Phase 2+ as scenarios need it. Adding
it speculatively now would lock in a shape before we know what scenarios
actually require.

## Backend implementations

### EmulatedBackend (`test/fedtest/emulated.ts`)

- Spawns N `Bun.serve` instances on ephemeral ports (`port: 0`, then read
  `server.port`).
- Each responds to `GET /info` with a body matching the real `buildInfo()`
  contract: `{ node, version, ts, maw: { schema: "1", ... } }`. We call
  `buildInfo()` directly and overwrite `node` per-peer so the shape stays
  in sync with production.
- `teardown()` calls `server.stop(true)` on each.
- Pattern borrowed from `test/integration/plugin-install-at-peer.test.ts`
  and `test/integration/search-peers-2port.test.ts`.

### DockerBackend (`test/fedtest/docker.ts`)

- Thin wrapper around `scripts/test-docker-federation.sh` — **no rewrite**
  (per #655 open question 4: "wrap — zero regression risk on the shipped
  harness").
- `setUp({ peers: 2 })` runs `docker compose -f docker/compose.yml up -d
  --build`, waits for healthchecks, returns two `PeerHandle`s pointing at
  `http://127.0.0.1:13456` / `:13457` (the published host ports) with
  `node: "node-a"` / `"node-b"`.
- `setUp({ peers: n })` where `n !== 2` throws — Phase 1's docker compose
  is fixed at 2 nodes. Phase 5 can parameterise.
- `teardown()` runs `docker compose … down -v`.
- Skips gracefully when `docker` isn't on PATH (SKIP sentinel, same
  pattern as `test/integration/*`).

## Scenario + runner

```ts
// test/fedtest/scenario.ts
export interface Scenario {
  name: string;
  /** Optional backend restriction — defaults to "both". */
  backends?: Array<"emulated" | "docker">;
  setUp?(backend: BaseFederationBackend): Promise<void>;
  assert(peers: PeerHandle[], backend: BaseFederationBackend): Promise<void>;
  teardown?(): Promise<void>;
  /** Peers to spin up. Default: 2. */
  peers?: number;
}
```

`runner.ts` — imports every `scenarios/*.ts` file, picks the backend
from `process.env.BACKEND` (default `emulated`), and for each scenario:

1. `backend.setUp({ peers: scenario.peers ?? 2 })`
2. `await scenario.assert(peers, backend)` inside a `bun:test` `test()`
3. `backend.teardown()` in a `finally`

This makes the runner a plain `bun test` target — no custom harness loop,
no reinvented assertion library. Failures surface as standard `bun test`
failures.

## Canary scenario: 01-handshake

`test/fedtest/scenarios/01-handshake.ts` does exactly what
`scripts/test-docker-federation.sh` does today, but via the harness:

1. Spin up 2 peers.
2. For each peer, call `probePeer(peer.url)` (from
   `src/commands/plugins/peers/probe.ts`).
3. Assert `result.node === peer.node` and `result.error === undefined`.

On emulated: ~500ms total. On docker: ~30s (most of it `up -d --build`).

## Scope limits (explicit)

- **No Phase 2 scenarios** (02 search-happy, 03 offline, 04 slow, 05
  install-at-peer) — they land next round.
- **No CI workflow wiring** — `.github/workflows/fedtest.yml` is a
  follow-up PR.
- **No `PeerHandle` mutation API** (`installPlugin`, `setSlow`, etc.) —
  Phase 2 adds these driven by scenario demand.
- **Docker backend is 2-node only** — matches the existing compose file.
- **Each file ≤200 LOC** — keeps the harness readable; any blow-up
  signals a premature abstraction.

## Why wrap, not rewrite, the docker script

`scripts/test-docker-federation.sh` is the shipped artefact that CI
already runs (`.github/workflows/federation-docker.yml`). Rewriting it in
TS means re-validating healthcheck polling, log dumping, teardown on
trap — work with zero upside for Phase 1. The wrapper shells out and
checks exit code; when Phase 5 needs richer introspection
(`setSlow`/`setOffline` at container level), we add it then.

## File layout

```
test/fedtest/
├── backend.ts          # interface + PeerHandle
├── emulated.ts         # EmulatedBackend (Bun.serve)
├── docker.ts           # DockerBackend (wraps shell script)
├── scenario.ts         # Scenario type + helpers
├── runner.ts           # loads scenarios/*.ts, picks backend
└── scenarios/
    └── 01-handshake.ts # canary — /info round-trip

docs/testing/
└── fedtest-phase1.md   # this doc
```

## Running

```bash
# Default backend — emulated, fast
bun test test/fedtest/runner.ts

# Explicit
BACKEND=emulated bun test test/fedtest/runner.ts

# Docker — needs docker engine running; skipped otherwise
BACKEND=docker bun test test/fedtest/runner.ts
```

`test:all` script keeps working because the runner is just a `bun test`
file — it picks up via the existing glob without a scripts/package.json
edit.

## Follow-ups (tracked separately)

- Phase 2: scenarios 02–05, `PeerHandle` mutation API.
- CI wiring: `.github/workflows/fedtest.yml` (emulated on every PR,
  docker nightly).
- Phase 5: docker backend supports `peers: N` by templating compose.
