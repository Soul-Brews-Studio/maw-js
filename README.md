# maw

> Multi-Agent Workflow — wake oracles, talk across machines, see the mesh.

## Install

```bash
# One line:
curl -fsSL https://raw.githubusercontent.com/Soul-Brews-Studio/maw-js/main/install.sh | bash

# Or manually:
bun add -g github:Soul-Brews-Studio/maw-js

# Or from source:
ghq get Soul-Brews-Studio/maw-js && cd "$(ghq root)/github.com/Soul-Brews-Studio/maw-js" && bun install && bun link
```

## Quick Start

```bash
maw serve                                # start API + UI on :3456
maw ui --install                         # download the federation lens
maw ui                                   # → http://localhost:3456/federation_2d.html
maw ls                                   # list sessions + windows
maw wake neo                             # wake an oracle
maw hey neo "what are you working on?"   # talk to it
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
maw hey white:neo "hello"                # send to oracle on another node
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

The lens reads `?host=` at runtime ([drizzle studio pattern](https://local.drizzle.studio)). Packed-serve mode: `maw ui --install` downloads the lens, `maw serve` serves it alongside the API on a single port.

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
├── src/commands/  (48 commands)    ├── src/components/
├── src/api/       (20 endpoints)   ├── src/hooks/
├── src/engine/    (WebSocket)      ├── src/lib/
├── src/transports/ (HTTP/tmux)     └── 16 HTML entry points
├── test/          (28 test files)
└── install.sh
```

## Evolution

```
Oct 2025   maw.env.sh        30+ shell commands
Mar 2026   maw.js             Bun/TS rewrite, tmux orchestration
Mar 2026   maw-js + maw-ui    Backend/frontend split
Apr 2026   v1.10.1            Federation mesh, 611 commits, 48 commands,
                               20 API endpoints, 500+ tests, 8 contributors
```
