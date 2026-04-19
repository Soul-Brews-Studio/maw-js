# `/info` 404 on a running peer — stale-process diagnosis

## Dogfood finding (2026-04-19)

A field report called out: `curl http://localhost:3456/info` returns 404
even though `pm2 status` shows `maw` online and listening on :3456. The
task description theorised **port collision with maw-studio** — i.e.
that the new `maw-studio` repo had grabbed :3456 as its default.

That theory was checked empirically and **ruled out**. The actual cause
is narrower and a recurring operational footgun: **the PM2-managed `maw
serve` process is a stale version that predates the `/info` endpoint**.

## Ground-truth probe

Fresh server on a free port:

```
$ bun run src/core/server.ts  # MAW_PORT=3457
maw v26.4.18-alpha.26 (…) serve → http://localhost:3457 (…) [127.0.0.1]

$ curl -s localhost:3457/info
{"node":"white","version":"26.4.18-alpha.27","ts":"2026-04-19T01:08:18Z","maw":{"schema":"1","plugins":{"manifestEndpoint":"/api/plugins"},"capabilities":["plugin.listManifest","peer.handshake","info"]}}
$ echo $?
0  # HTTP 200 — /info is correctly mounted
```

So on current source, `/info` works. That rules out:

- **Option 2 (contract drift)** — probe hits `/info`, server serves `/info`.
- **Option 3 (#603 regression)** — the route is registered at
  `src/views/index.ts:10`: `app.route("/info", infoView)`, and the
  handler at `src/views/info.ts:42` returns the expected shape.

## What's on :3456 then?

```
$ pm2 info 0
script path  /home/neo/Code/.../maw-js/src/core/server.ts
version      2.0.0-alpha.6
uptime       5D
```

The PM2-managed `maw` process is on **alpha.6**, started 5 days ago.
Current source is **alpha.26** — 20 patch versions ahead. `/info` was
added in **PR #603** (commit `09ee0b9`), which merged after alpha.6.

```
$ curl -s localhost:3456/info
404 Not Found
$ curl -s localhost:3456/api/plugins | head -c 80
[{ api: { methods: [   # old pretty-printed shape — current code emits compact JSON
```

The root HTML on both :3456 and :3457 is the same "ARRA Office" page
from `MAW_UI_DIR`, so :3456 is unambiguously an older `maw serve`,
not `maw-studio`.

## maw-studio is not the culprit

`/home/neo/Code/github.com/Soul-Brews-Studio/maw-studio/` is a **static
proposal repo** — `index.html` + `PROPOSAL.md` + `assets/`. No server,
no port binding, not running. The original theory was wrong.

## Root cause

**PM2 does not automatically restart `maw` when the source bumps
versions.** `ecosystem.config.cjs` sets `watch: false` deliberately
("production: restart manual after deploy only") and `max_restarts: 5`
prevents accidental restart loops. Both are good defaults. But the
deploy step — `pm2 restart maw` after `git pull` — is left to the
operator, and is easy to forget.

`ecosystem.config.cjs` already points at the current path
(`src/core/server.ts`), so **`pm2 restart maw` would immediately pick
up `/info`** — no config change needed.

## Why this is worth fixing beyond the operator reminder

A stale peer is a **silent federation failure mode**: the peer responds
to HTTP, so liveness checks pass, but the handshake fails with an
opaque 404. The current `PROBE_HINTS.HTTP_4XX` message says:

> Peer responded with a client error. /info endpoint may be missing.

Which reads as a code-level diagnosis ("the peer doesn't implement
/info at all") — misleading when the truth is more often "the peer is
old and that version predates the endpoint." An operator who sees the
current hint may go looking for a bug in the peer's codebase instead
of just restarting the peer.

## Proposed fix

1. **Update `PROBE_HINTS.HTTP_4XX`** to name the stale-version case
   explicitly. Something like:

   > Peer responded with a client error. Peer may be running an old
   > version that predates /info — try restarting it (`pm2 restart
   > maw` / `maw serve --restart`).

2. **Out of scope here** (flag for follow-ups, don't bundle):
   - A `maw doctor` check that compares running-process version against
     `package.json` and warns on drift.
   - An auto-restart hook on `maw serve` upgrades (risky — breaks the
     deliberate `watch: false` / `max_restarts: 5` posture).
   - A pm2 post-deploy hook in `release` skill.

## File budget

One-line change to the `HTTP_4XX` entry in
`src/commands/plugins/peers/probe.ts:27`. Plus one peers.test.ts
assertion that the new hint mentions "old version" / "restart" so the
wording doesn't silently regress.

## References

- PR #603 (`09ee0b9`) — `feat(transport): add /info endpoint for peer handshake (closes #596)`
- `src/views/index.ts:10` — `/info` route registration (confirmed mounted)
- `src/views/info.ts` — handler, returns `{node, version, ts, maw: {schema, plugins, capabilities}}` as of #628; pre-#628 peers return `{…, maw: true}` and are still accepted by the probe gate.
- `src/commands/plugins/peers/probe.ts:27` — current `HTTP_4XX` hint
- `ecosystem.config.cjs` — pm2 config (correct path, `watch: false`)
- `docs/federation/peer-handshake-errors.md` — #565 sibling doc
