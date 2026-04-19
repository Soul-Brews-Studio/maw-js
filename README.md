# maw

[![CI](https://github.com/Soul-Brews-Studio/maw-js/actions/workflows/ci.yml/badge.svg)](https://github.com/Soul-Brews-Studio/maw-js/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-BUSL--1.1-blue)](./LICENSE) [![CalVer](https://img.shields.io/badge/calver-v26.4.18--alpha.19-blue)](https://calver.org) [![Bun](https://img.shields.io/badge/runtime-Bun%201.3%2B-f9f1e1)](https://bun.sh)

> Multi-Agent Workflow — wake agents, talk across machines, see the mesh.

**maw is a CLI for running multiple AI agents across machines.** You wake
an agent in a tmux window, send it tasks, watch its screen, and see what
it cost — all from one terminal. One node or twenty; same commands. Built
on [Bun](https://bun.sh) and [Claude Code](https://claude.com/claude-code).

<!-- TODO: record via scripts/record-demo.sh after this lands (see #453) -->
![maw demo](docs/demo.svg)

## Install

```bash
# One line:
curl -fsSL https://raw.githubusercontent.com/Soul-Brews-Studio/maw-js/main/install.sh | bash

# Or manually:
bun add -g github:Soul-Brews-Studio/maw-js

# Or from source:
ghq get Soul-Brews-Studio/maw-js && cd "$(ghq root)/github.com/Soul-Brews-Studio/maw-js" && bun install && bun link
```

> **Versioning**: `maw-js` uses [CalVer](https://calver.org) — `v{yy}.{m}.{d}[-alpha.{hour}]` (e.g. `v26.4.18-alpha.19`). Migrated from SemVer alpha on 2026-04-18. Cutting a release? See [CONTRIBUTING.md → Versioning](./CONTRIBUTING.md#versioning). Background: [CHANGELOG](./CHANGELOG.md#versioning--calver-since-2026-04-18) · umbrella [#526](https://github.com/Soul-Brews-Studio/maw-js/issues/526).

## Recovering from `maw: command not found`

If `maw` vanishes unexpectedly (see [#531](https://github.com/Soul-Brews-Studio/maw-js/issues/531) — root cause: npm name collision, fixed in #557 via rename to `maw-js`), recovery paths:

1. **One-shot reinstall**: `bun add -g github:Soul-Brews-Studio/maw-js`
2. **Self-heal command**: `bunx -p github:Soul-Brews-Studio/maw-js maw doctor` — auto-detects + restores
3. **Shell hook**: source `scripts/maw-heal.sh` from your `.bashrc` / `.zshrc` — checks on every shell init

Defense-in-depth: `maw update` stashes the binary to `~/.bun/bin/maw.prev` before any destructive `bun remove` and restores on retry-fail (#551). `maw doctor` remains useful if the binary disappears for other reasons (older alpha, manual `bun remove`, disk full, etc.).

Full runbook: [`docs/install-recovery.md`](docs/install-recovery.md).

## Quick Start

```bash
maw serve                                # start API + UI on :3456
maw ui install                           # download the federation lens
maw ui                                   # → http://localhost:3456/federation_2d.html
maw ls                                   # list sessions + windows
maw wake neo                             # wake an oracle
maw hey neo "what are you working on?"   # talk to it
```

## Installing the UI

`maw` installs API-only. The React frontend ships separately from
[Soul-Brews-Studio/maw-ui](https://github.com/Soul-Brews-Studio/maw-ui).

### Quick install (recommended — requires `gh` auth)

```bash
maw ui install                       # latest release
maw ui install --version v1.15.0     # specific version
maw ui status                        # verify installation
```

Downloads `dist.tar.gz` from the maw-ui GitHub Release and extracts to
`~/.maw/ui/dist/`. Restart the maw server to serve the new UI.

### Manual install (no `gh`)

```bash
# Download dist.tar.gz from a release page, then:
mkdir -p ~/.maw/ui/dist
tar -xzf dist.tar.gz -C ~/.maw/ui/dist --strip-components=1
```

### Build from source

```bash
ghq get -u github.com/Soul-Brews-Studio/maw-ui
cd "$(ghq root)/github.com/Soul-Brews-Studio/maw-ui"
bun install && bun run build
ln -sf "$(pwd)/dist" ~/.maw/ui/dist
```

## Wake from anywhere

```bash
maw wake org/repo                        # clone via ghq + wake
maw wake https://github.com/org/repo     # full URL works too
maw wake org/repo --issue 5              # clone + send issue as prompt
maw bud myname --root                    # create a fresh oracle (no parent)
maw bud myname --from neo                # bud from an existing oracle
# 👉 maw bud <stem> always creates repo <stem>-oracle.
#    Never include "-oracle" in <stem> — it doubles the suffix.
#    e.g.  maw bud fusion       → fusion-oracle ✓
#          maw bud fusion-oracle → fusion-oracle-oracle ✗
```

## Federation

Talk across machines with HMAC-SHA256 signing.

```bash
maw hey neo "hello"                      # bare name — exact local match (errors on ambiguity)
maw hey white:neo "hello"                # canonical form — remote node, window 1
maw hey white:neo:3 "hello hermes"       # pick a specific tmux window (#410)
maw peek white:neo                       # see their screen
maw ping                                 # check peer connectivity

# Config (maw.config.json)
{
  "node": "oracle-world",
  "federationToken": "shared-secret-min-16-chars",
  "namedPeers": [{ "name": "white", "url": "http://10.20.0.7:3456" }]
}
```

## The Lens (maw-ui)

See the mesh in a browser. Any federation can point the lens at any backend:

```bash
maw ui                                   # local lens
maw ui white                             # lens pointed at white's data
maw ui --tunnel 10.20.0.16               # SSH tunnel + lens URL
```

The lens reads `?host=` at runtime ([drizzle studio pattern](https://local.drizzle.studio)). Packed-serve mode: `maw ui install` downloads the lens, `maw serve` serves it alongside the API on a single port.

Frontend repo: [Soul-Brews-Studio/maw-ui](https://github.com/Soul-Brews-Studio/maw-ui)

## CLI

```bash
maw ls                           # list sessions + windows
maw peek [agent]                 # see agent screen
maw hey <agent> <msg>            # send message
maw wake <oracle> [task]         # wake oracle in tmux
maw sleep <oracle>               # gracefully stop
maw done <window>                # auto-save + clean up
maw bud <name> [--from parent]   # spawn new oracle
maw fleet ls                     # list fleet configs
maw fleet health                 # fleet health report
maw fleet doctor                 # config doctor
maw oracle scan                  # discover oracles across nodes
maw contacts                     # list oracle contacts
maw soul-sync                    # sync memory across peers
maw find <keyword>               # search memory across oracles
maw ui                           # open federation lens
maw serve [port]                 # start API server (default: 3456)
```

Full command reference: `maw --help`

## Federation API

| Endpoint | Purpose |
|----------|---------|
| `GET /api/config` | Node identity + agents map |
| `GET /api/fleet-config` | Fleet entries with sync_peers + lineage |
| `GET /api/feed?limit=200` | Live event log |
| `GET /api/federation/status` | Peer connectivity |
| `POST /api/peer/exec` | Signed command relay between nodes |
| `POST /api/proxy/*` | HTTP relay for mixed-content peers |

Full reference: [`docs/federation.md`](docs/federation.md)

## Architecture

```
maw-js (backend + CLI)              maw-ui (frontend)
├── src/commands/  (57 commands)    ├── src/components/
├── src/api/       (19 endpoints)   ├── src/hooks/
├── src/engine/    (WebSocket)      ├── src/lib/
├── src/transports/ (HTTP/tmux/hub) └── 16 HTML entry points
├── test/          (94 test files)
└── install.sh
```

## Evolution

```
Oct 2025   maw.env.sh            30+ shell commands
Mar 2026   maw.js                 Bun/TS rewrite, tmux orchestration
Mar 2026   maw-js + maw-ui        Backend/frontend split
Apr 2026   v2.0.0-alpha.66        Plugin OS, 896 commits, 57 commands,
                                   19 API endpoints, 1043 tests
```

## Federation testing

Peer handshake regressions hide on a single host. The Docker harness
spins up two `maw-js:test` containers on a shared network and runs
`maw peers probe` both directions as a round-trip smoke test.

```bash
bash scripts/test-docker-federation.sh   # build + up + probe + teardown
bash scripts/dev-federation.sh up        # leave the 2-node stack running
```

CI runs the same script via `.github/workflows/federation-docker.yml`
on any PR that touches `docker/**`, `src/transports/**`, or the peers
plugin. Full runbook: [`docs/federation/docker-testing.md`](docs/federation/docker-testing.md).

Onboarding a new node? Use `maw pair generate` / `maw pair <url> <code>`
for a 6-char ephemeral handshake — see
[`docs/federation/pair-code.md`](docs/federation/pair-code.md).

## Marketplace

Plugins can be discovered and installed peer-to-peer (Shape A, no central
registry required). See
[`docs/plugins/shape-a-demo.md`](docs/plugins/shape-a-demo.md) for a
7-step walkthrough — peers, federated search, `@peer` install, consent.
