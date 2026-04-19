# Container-native oracle prototype

**Status:** prototype for #627 scope expansion. Not wired into CI. Not the
canonical docker harness (that's `docker/Dockerfile` / `docker/compose.yml`,
which ships a 2-node symmetric maw federation).

## What this is

A Claude-Code runtime with a persistent oracle identity, running inside a
Docker container, federating to a host `maw serve` over the compose network.

```
Host                             Container
host-maw (3456)  ◀── /info ──▶   oracle-a (3456)
                                 ├── /app        (maw-js checkout)
                                 ├── /home/oracle/.claude  (persistent volume)
                                 ├── /home/oracle/.maw     (persistent volume)
                                 └── /usr/local/bin/claude (claude-code CLI)
```

The container-oracle is a **symmetric peer** — it runs `maw serve` itself so
the host can probe it back. That's what gets it to appear in
`maw peers list` on the host, not just as a one-way client.

## Demo

### 1. Build + up

```sh
# Required for claude-code inside the container; never hardcoded in the image.
export ANTHROPIC_API_KEY=sk-ant-...

cd <maw-js-repo>
docker compose -f docker/oracle-container/compose.yml up --build
```

Two services come up:

- `host-maw` — stand-in for your host's `maw serve`, port 13456 on the host
- `oracle-a` — the container-native oracle, port 13458 on the host

### 2. Verify the handshake

Both nodes should see each other as peers after ~10s:

```sh
# From host-maw's perspective — oracle-a should appear.
docker compose -f docker/oracle-container/compose.yml exec host-maw \
  maw peers list

# From oracle-a's perspective — host should appear.
docker compose -f docker/oracle-container/compose.yml exec -u oracle oracle-a \
  maw peers list
```

Expected (shape, not exact formatting):

```
alias    url                      node      lastSeen
oracle-a http://oracle-a:3456     oracle-a  2026-04-19T…Z
```

### 3. Probe identity persistence

```sh
docker compose -f docker/oracle-container/compose.yml exec -u oracle oracle-a \
  cat /home/oracle/.claude/identity.json
# → {"schema": "0", "node": "oracle-a", "born": "…", "note": "…"}

docker compose -f docker/oracle-container/compose.yml down   # stops containers
docker compose -f docker/oracle-container/compose.yml up -d  # brings them back

docker compose -f docker/oracle-container/compose.yml exec -u oracle oracle-a \
  cat /home/oracle/.claude/identity.json
# → identical `node` and `born` — the identity survived the restart.
```

### 4. Run claude-code inside the container

```sh
docker compose -f docker/oracle-container/compose.yml exec -u oracle oracle-a \
  claude --version
# → the claude CLI reports its version — proves claude-code is installed and
#   ANTHROPIC_API_KEY is visible to the runtime.
```

### 5. If the build fails (no API key, no network, etc.)

Dry-run proof-of-shape without building:

```sh
docker compose -f docker/oracle-container/compose.yml config
```

This should parse cleanly and show both services, the network, and the
three named volumes. That verifies the shape of the prototype even when a
full `up --build` isn't available in the environment.

## Identity model

This prototype persists oracle identity as a **node name only**, stored at
`/home/oracle/.claude/identity.json` inside the `oracle-a-claude` volume.

Precedence on boot:

1. `$ORACLE_NAME` env var (wins — lets the compose file pin the name)
2. `node` field in `$CLAUDE_CONFIG_DIR/identity.json` (reused across restarts)
3. Random `oracle-<6-char-stem>` (first-boot fallback)

Full keypair-based identity (pubkey hash → node name, signed registrations)
is out of scope for this prototype and is tracked under the rfc-identity
RFC (#629). The current `identity.json` has a `note` field saying so.

## What is NOT done

Deliberate deferrals — so Nat can scope the follow-up:

- **Keypair identity.** No signing, no pubkey-derived names, no trust
  boundary between oracles. Deferred to #629 (rfc-identity RFC).
- **Auth on the federation edge.** `maw peers add` takes any URL; a rogue
  container on the same network could register itself. Deferred to #642
  (scoped routing + trust RFC).
- **Multi-oracle scaling.** The compose file hardcodes one `oracle-a`.
  Running N container oracles means N compose services (or a separate
  swarm/k8s deployment). Prototype doesn't address orchestration.
- **Lifecycle / garbage collection.** No reaping of dead container oracles
  from the host's `peers.json`. If you `docker compose down` without
  `maw peers remove`, the host keeps a stale entry (the probe loop will
  mark it unreachable but not remove it).
- **Claude-Code session persistence.** `/home/oracle/.claude` is a volume,
  but there's no test that a claude session resumed across restarts
  actually carries its context. Works-in-theory, unverified.
- **Vault bind-mount.** Commented out in compose; the path varies per dev.
  Real use would pass `HOST_VAULT=/path/to/ψ` and uncomment the mount.
- **CI integration.** This compose file is not referenced by `bun run ci`
  or `test/fedtest/`. The canonical harness remains `docker/compose.yml`.
- **One-shot vs. long-running modes.** The CMD is hardcoded to `maw serve`.
  A "run a single claude invocation and exit" mode is trivial to add
  (override CMD) but isn't wired into the entrypoint yet.

## File layout

```
docker/oracle-container/
├── Dockerfile       # bun + maw-js + claude-code, non-root `oracle` user
├── entrypoint.sh    # identity load-or-mint, maw init, peer register, serve
├── compose.yml      # host-maw + oracle-a, shared network, named volumes
├── .dockerignore
└── README.md        # this file
```

Shape-verified via `docker compose config`; real `up --build` requires
network access to `registry.npmjs.org` and a valid `$ANTHROPIC_API_KEY`.
