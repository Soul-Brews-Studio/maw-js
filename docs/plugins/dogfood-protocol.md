# Cross-oracle dogfood protocol

Status: PROTOCOL — how to repeat the mesh-child validation run.
Tracking issue: [#634](https://github.com/Soul-Brews-Studio/maw-js/issues/634)
Companion: [marketplace-rfc.md](./marketplace-rfc.md) (Shape A),
[search-peers-impl.md](./search-peers-impl.md) (#631 implementation).
Date: 2026-04-19

## Purpose

Prove that two independent oracles can discover and install each other's
plugins over the maw federation transport, end-to-end, on one laptop or
across nodes. This is the acceptance check for Shape A (federated plugin
discovery). Mesh-child ran it once; this doc pins the steps so anyone can
repeat it without reconstructing the session.

## Prerequisites

Before starting:

1. **Two oracles awoken on distinct ports.** Use `maw bud <stem>` to birth a
   budded oracle, then `maw wake <stem>-oracle` to bring it up. The peer
   must bind a different port from the host oracle (`maw.config.json :: port`).
2. **Both oracles reachable.** `curl http://localhost:<port>/info` returns
   `200` with a maw-shaped body on both. If either returns `404` or connection
   refused, fix `maw wake` before continuing.
3. **Peer handshake succeeded.** On each side:
   `maw peers add <alias> http://localhost:<port>` then
   `maw peers probe <alias>` — `lastSeen` must populate. `(offline)` means the
   handshake failed; see "Common failures" below.
4. **maw-plugins checkout (optional, only for test 3).** Clone
   `Soul-Brews-Studio/maw-plugins` and run `./setup.sh` from its root to
   install workspace deps. Required if you want to exercise
   `maw plugin install <path> --link`.

## Test matrix

Run each test from the **caller** oracle (the one initiating). Peer is the
**target**. Swap roles and re-run for full bidirectional coverage.

### 1. Basic hey — transport liveness

```
$ maw hey <peer-alias> "ping"
```

Expected: peer receives the message (visible in `maw inbox` on the peer or as
a tmux note if the peer has an active pane), and caller sees a non-error
ack. Round-trip latency should be under a second on localhost.

Fails if: transport is broken. Stop here and re-probe before moving on.

### 2. Peer probe — registry + handshake

```
$ maw peers add <alias> http://<host>:<port>
$ maw peers probe <alias>
$ maw peers info <alias>
```

Expected:

- `peers add` writes to `~/.maw/peers.json`.
- `peers probe` reports a `lastSeen` ISO timestamp within the last few
  seconds and the peer's `node`, `version`, `schemaVersion`, `capabilities`
  (post-#628 `/info` enrichment).
- `peers info` prints the full record including `nickname` if the peer has
  set one via `maw oracle set-nickname`.

Fails if: `/info` returned 4xx/5xx, body was not maw-shaped, or the URL was
unreachable. See "Common failures".

### 3. Plugin install via `--link` — local dev workflow

From a maw-plugins checkout:

```
$ cd <maw-plugins>/packages/20-ping
$ maw plugin install . --link
$ maw ping
```

Expected:

- `install --link` symlinks the package into `~/.maw/plugins/ping/` rather
  than copying. An auto-link from `~/.maw/plugins/ping/node_modules/maw-js`
  → the caller's maw-js checkout is created (closes #641; verify with
  `ls -l ~/.maw/plugins/ping/node_modules/maw-js`).
- `maw ping` prints a pong line.

Fails if: `node_modules/maw-js` is missing (pre-#641 behavior) or the
plugin can't resolve `maw-js/sdk` imports. Re-run `maw plugin install . --link`
from the plugin's own directory to trigger the auto-link.

### 4. Shape A federated search — cross-oracle discovery

```
$ maw plugin search <query> --peers
$ maw plugin search <query> --peers-only
```

Expected:

- With `--peers`, output has two sections: `registry (…)` and
  `peers (N queried, M responded in X.Ys)`. Each peer hit is annotated with
  `@<peerName>` or `@<peerNode>`.
- With `--peers-only`, registry section is skipped.
- If the peer has zero plugins matching, it still shows in the
  `queried` count but not in hits.
- Unreachable or timed-out peers appear in a trailing `errors:` block with
  `reason: "timeout" | "unreachable" | "bad-response" | "http-error"`.

Fails if: `--peers` flag is unknown (your maw-js is pre-#631; upgrade) or
the peer's `/api/plugin/list-manifest` returns non-200 (peer is pre-#631).

### 5. `@peer` install — fetch from peer tarball

Note: as of 2026-04-19 this is a **follow-up** behind task #1 (still
in-progress). When landed:

```
$ maw plugin install <name>@<peer-alias>
```

Expected: caller fetches the tarball from the peer's
`/api/plugin/get/<name>` (or equivalent; see #1 for final API shape), pins
sha256 to `plugins.lock`, and installs via the existing install pipeline.

Fails gracefully today with `unknown install spec` until #1 ships. Skip
this row on pre-#1 maw-js.

### 6. Nickname display — identity layer

Set a nickname on the peer, then probe from the caller:

```
peer$ maw oracle set-nickname "Mesh Child"
caller$ maw peers probe <alias>
caller$ maw peers info <alias>
```

Expected: `peers info` shows `nickname: Mesh Child` (propagates via the
post-#628 `/info` body and gets stored on the peer record).

Fails if: peer's maw-js predates the nickname wire (#643). Upgrade peer
and retry.

## Common failures and diagnosis

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `ECONNREFUSED` on `/info` | peer not awake or PM2 process stale | `maw wake <peer>` then `maw ls` to confirm RUNNING |
| `/info` returns 404 | old maw-js, pre-`/info` endpoint | upgrade peer to ≥ alpha with #628 landed |
| `probe` says `(offline)` but curl works | hostname mismatch (localhost vs 127.0.0.1 vs LAN IP) | re-add peer with the exact URL `curl` succeeded against |
| `maw plugin install --link` runs but `maw ping` says "plugin not found" | auto-link missing (pre-#641) | upgrade maw-js; re-run install |
| `--peers` flag rejected | caller pre-#631 | upgrade caller to ≥ the alpha that shipped search-peers |
| `--peers` returns `0 responded` | peer pre-#631 (no list-manifest endpoint) | upgrade peer |
| `maw hey <peer>` times out, probe is green | peer has no active pane / tmux session — the message queued but nothing is listening | start a pane on peer via `maw wake` or `maw take <peer>` |
| Port collision at wake time | two oracles bound the same port | edit `maw.config.json :: port` on one side, `maw restart` |
| DNS for cross-node test | peer's URL resolves on caller's box? | fall back to raw IP or a Cloudflare tunnel |
| Stale PM2 process after config change | PM2 cached old port / node name | `maw stop <peer> && maw wake <peer>` (not `restart`) |

## How to report findings

After a run:

1. Write a report under
   `ψ/reports/dogfood-<YYYYMMDD>-<stem>.md` with sections:
   - **Setup** — caller/peer aliases, ports, versions (`maw --version`).
   - **Matrix** — one line per test (1–6), PASS/FAIL/SKIP, elapsed time,
     anything weird.
   - **Issues found** — any matrix miss, with a minimal repro.
   - **Next** — file issues for true regressions, link them here.
2. Notify the lead:
   ```
   $ maw hey <lead> "dogfood <stem>: <P/F counts> — <report-path>"
   ```
3. If a test failed due to a previously-unknown bug, open a GitHub issue
   with the report linked and tag it with the relevant area
   (`plugin:search-peers`, `peers`, `hey`, etc.).

## Known case studies

- **Mesh-child / mawjs-plugin-oracle — first Shape A validation run.**
  Ran tests 1, 2, 3, 4 against a freshly-budded oracle on the same host;
  validated that `--peers` fanout works end-to-end and that a plugin built
  in one oracle's workspace could be discovered by the other. Surfaced
  #641 (auto-link on `--link` install) and informed the #631 error taxonomy.
- **Future runs** — add a bullet here after each successful dogfood pass
  so the protocol stays anchored to real evidence, not prose.

## Scope (what this doc is and isn't)

- **Is**: a repeatable recipe for validating Shape A on a fresh pair of
  oracles. Matrix-first, prose-light. Assumes the reader has maw-js
  already installed and a working shell.
- **Isn't**: an install guide for maw itself (see the root `README.md`), a
  spec for Shape A (see `marketplace-rfc.md`), or an implementation
  reference (see `search-peers-impl.md`). Deliberately stops at "two
  oracles" — a 3+ peer mesh deserves its own doc once we have one.
