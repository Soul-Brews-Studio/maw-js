# cross-team-queue — plugin analysis (2026-04-19)

Issue: #515. Prior art: #505 (david-oracle's built-in shape).

## (a) VAULT_ROOT resolution

`MAW_VAULT_ROOT` env is **required**. No hardcoded `~/<name>-oracle/` default. If
missing or empty → handler returns `{items: [], stats: {}, errors: [{file: "<config>", reason: "MAW_VAULT_ROOT not set"}]}` with `ok: true`.

Rationale: issue spec explicitly forbids silent fallback; a missing vault-root is
a config error that should surface loudly via the `errors[]` channel, not a
500 or a `{items: []}` that looks like "no data".

Per-oracle subdirectory layout assumed: `${MAW_VAULT_ROOT}/<oracle>/ψ/memory/<oracle>/inbox/*.md`.

## (b) Frontmatter parse strategy — minimal YAML subset

Hand-rolled parser in `scan.ts`. Supported:

- `key: value` → string
- `key: [a, b, c]` → string[]
- `key: true|false` → boolean
- `key: 42` → number
- Blank lines between `---` fences ignored.

NOT supported (by design): nested maps, multi-line strings, anchors, refs, flow
mappings. Anything else → raised as a `ParseError` for that file (not silent-dropped).

Rationale: no `js-yaml` dep (supply-chain minimization + ~60 KB saved); inbox
notes in practice only use flat key/value and small list frontmatter.

## (c) Error-surfacing shape

```ts
type ParseError = { file: string; reason: string };
```

Returned via `{errors: ParseError[]}` alongside `{items, stats}`. Classes:

1. `MAW_VAULT_ROOT not set` (config) — single synthetic error, `file: "<config>"`.
2. `vault root does not exist` — synthetic error, `file: vaultRoot`.
3. Per-file: `missing frontmatter`, `malformed frontmatter`, `unknown list syntax`,
   `read failed: <io error>`.

Loud signal = test asserts `errors.length > 0` for each class. No silent-200 with
empty `items[]` when a frontmatter parse fails.

## (d) File-per-concern split (≤ 200 LOC each)

```
src/commands/plugins/cross-team-queue/
├── plugin.json       # manifest (api.path = /api/plugins/cross-team-queue, GET)
├── index.ts          # handler: flag parsing + response assembly   (≤ 120)
├── types.ts          # InboxItem, QueueResponse, ParseError, Filter (≤ 60)
└── scan.ts           # fs walker + frontmatter parser + filters     (≤ 180)
```

Mirror contract: `src/shared/cross-team-queue.types.ts` — re-export `InboxItem`
and `QueueResponse` so a future UI can import without pulling in plugin code.

Prior art: `src/commands/plugins/signals/` uses the same `index.ts + shared/scan-*`
pattern — we follow it verbatim.

## (e) Test plan

1. **Unit — `scan.test.ts`**
   - frontmatter parse: key/value, list, boolean, number
   - malformed frontmatter → `ParseError` with `reason: "malformed frontmatter"`
   - missing frontmatter → `ParseError`
   - filter matches: recipient, team, type, maxAgeHours (mtime-derived)
   - fixtures under `test/fixtures/cross-team-queue/` — real `.md` files
2. **Integration — `cross-team-queue.test.ts`**
   - CLI surface: `ctx.source: "cli"` returns `ok: true`
   - API surface: `ctx.source: "api", args: {}` returns `{items, stats, errors}`
   - missing `MAW_VAULT_ROOT` → `errors[]` has config-missing entry (adversarial:
     test FAILS if we ever add a silent default back)
   - nonexistent vault root → `errors[]` has "does not exist"
3. **Smoke** — fleet vault path (env MAW_VAULT_ROOT) returns real data locally.

## Out of scope (per issue)

- Closing/modifying #505 (their team's call).
- UI integration (mawui/VELA — separate decision).
- Cross-fleet network sync (local-read only).

## PR split

Issue suggests 3 PRs (A/B/C, ≤300 LOC each). Real LOC estimate across the 4
source files is ~350 LOC **before** tests. We'll ship as a **single PR** with
the split noted in the PR body — the split points live in the git history
(commit-per-file), not in separate PRs. If reviewer disagrees we can rebase
into A/B/C.
