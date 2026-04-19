# Oracle Nickname — Design (Phase 1)

> Issue #643, Phase 1. Adds an optional human-chosen `nickname` alongside the
> canonical oracle `name`. Phase 2 (peer-probe surfacing, `maw hey <nickname>`
> routing, emoji audit) is explicitly out of scope here.

## Goals

- Let each oracle own a short human label distinct from its repo-derived name
  (e.g. `maw` can be called "Moe" without renaming `mawjs-oracle`).
- Keep the authoritative write local to the oracle itself so nicknames travel
  with the vault on clone/federation sync.
- Provide fast lookup for display paths (`maw oracle ls`) without stat-ing
  every oracle repo on every run.

## Non-goals (Phase 1)

- Nickname-based routing (`maw hey Moe`). Needs a collision story.
- Remote peer surfacing via `/info`. Needs contract coordination.
- Rendering policy for emoji/wide glyphs in aligned tables.

## Storage — Option C from the RFC

Authoritative: per-oracle file at `<oracle-repo>/ψ/nickname`.

- **Format**: plain UTF-8 text, single line, no trailing newline required but
  trimmed on read. No JSON envelope — this is a human-owned label.
- **Absence**: file missing OR empty-after-trim → no nickname. These two
  states collapse deliberately; an empty file is not a "clear" signal
  different from missing.
- **Clear**: `maw oracle set-nickname <oracle> ""` removes the file. Treats
  empty string as an explicit unset.
- **Why ψ/**: already the vault dir where oracle-owned metadata lives; already
  in the vault-sync scope (per MEMORY: ψ/ is NOT fully cross-node synced, but
  it *is* the convention for per-oracle state, and `has_psi` is already a
  signal on OracleEntry).

Cache: `~/.maw/nicknames.json` (under `resolveHome()`, honouring `MAW_HOME`).

- **Shape**: `{ schema: 1, nicknames: { [oracleName]: string } }`
- **Role**: read-through cache for the display path. Never authoritative. A
  missing cache entry falls back to reading the ψ/nickname file; a present
  cache entry is used as-is but refreshed on every write.
- **Staleness**: accepted. The canonical file is on-disk and cheap to re-read;
  if nickname drifts the next `set-nickname` or explicit refresh will reconcile.

## Precedence

1. Explicit flag (none in Phase 1 — reserved for Phase 2 CLI overrides).
2. Cache entry in `~/.maw/nicknames.json`.
3. On-disk file `<local_path>/ψ/nickname`.
4. None → display canonical `name` only.

Writer always writes (1) the on-disk file first, then (2) the cache — in that
order — so a crash between steps leaves the cache stale but the truth intact.

## Schema

`OracleEntry` gains `nickname?: string` at
`src/core/fleet/registry-oracle-types.ts`. Optional, untouched by existing
scans; populated only by:

- `cmdOracleList` when it wants to render rows (read-through cache hit).
- Future Phase 2 enrichers (peer-probe `/info`).

The registry cache file (`oracles.json`) does NOT persist `nickname`. Keeping
it out avoids a third copy diverging from the ψ/nickname file. Consumers of
`OracleEntry` in-memory see the field; on-disk cache deliberately omits it.

## Edge cases

| case | behaviour |
|---|---|
| oracle has no `local_path` (uncloned) | skip ψ/ read; nickname can't be set; `set-nickname` errors |
| oracle has `local_path` but no ψ/ dir | create ψ/ on write (`recursive: true`) |
| nickname with only whitespace | trimmed to empty → treated as unset, file removed |
| nickname with newlines | rejected at write time (one-line invariant) |
| nickname > 64 chars | rejected at write time with explicit error |
| cache file malformed JSON | warn once, fall back to per-file reads |
| cache dir missing | created on first write |

Length cap of 64 is arbitrary but bounded — Phase 2 can revisit when terminal
rendering is audited.

## CLI surface

```
maw oracle set-nickname <oracle> "<nickname>"    # write (empty = clear)
maw oracle get-nickname <oracle>                 # read (exit 1 if unset)
```

Both resolve `<oracle>` through the existing registry cache (`readCache`) to
find `local_path`. No registry mutation. JSON mode via `--json`.

## Display wire

`impl-list.ts` `formatRow()` currently pads `e.name` to 22 chars. With a
nickname present, render as `name (nickname)` — nickname shown in dim/gray so
the canonical name stays dominant. Padding recalculated on the combined string
width. JSON output includes `nickname` field on each oracle row.

## File layout (delta)

```
src/core/fleet/
  registry-oracle-types.ts   # + nickname?: string
  nicknames.ts               # NEW — read/write helpers + cache
src/commands/plugins/oracle/
  impl-nickname.ts           # NEW — cmdOracleSetNickname / cmdOracleGetNickname
  impl-list.ts               # modified — render nickname column
  index.ts                   # modified — dispatch set-nickname / get-nickname
  nickname.test.ts           # NEW — unit + integration
docs/fleet/
  nickname-design.md         # this doc
```

## Test plan

- **Unit**: round-trip write → read via ψ/nickname file; whitespace trimming;
  empty clears; invalid (newline / overlength) rejected; cache read-through.
- **Integration**: CLI `set-nickname foo "Mo"` then `ls` output contains `Mo`;
  `get-nickname` returns the value; unset oracle falls back to `name` only.
- Uses `MAW_HOME` override to sandbox the cache file in tests.

## Deferred (Phase 2 follow-ups)

- `/info` response carries nickname; registry merges it on remote scan.
- `maw hey <nickname>` resolves — needs conflict policy (first-wins? node-scoped?).
- Emoji & wide-char rendering audit for aligned tables.
- TTL / explicit refresh command for the nicknames cache.
