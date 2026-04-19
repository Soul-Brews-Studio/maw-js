# `maw bud --from-repo` — implementation analysis (#588)

Builds on `docs/bud/from-repo-design.md` + #591 scaffold + #595 local-path impl. This PR extends to **URL clone + `--pr` branch-and-PR flow**.

## (a) 8-TODO scope — this PR vs deferred

From #591 body:

| # | TODO                                            | #595   | This PR | Defer |
|---|-------------------------------------------------|--------|---------|-------|
| 1 | Actual fs writes (ψ/ + CLAUDE.md + .claude/)    | ✅ ship | —       | —     |
| 2 | URL / `org/repo` resolution via clone           | —      | ✅ ship | —     |
| 3 | `--pr` branch-and-PR flow                       | —      | ✅ ship | —     |
| 4 | Fleet entry creation (`configureFleet`)         | —      | —       | ✅    |
| 5 | CLAUDE.md append idempotency marker             | ✅ ship | —       | —     |
| 6 | Optional `--from <parent>` lineage in CLAUDE.md | —      | —       | ✅    |
| 7 | Optional `--seed` soul-sync from parent         | —      | —       | ✅    |
| 8 | Parent `sync_peers` update when `--from` given  | —      | —       | ✅    |

Cumulatively 5 of 8 shipped after this PR; 3 defer (fleet entry, `--from` lineage, `--seed`/`sync_peers`). `--force` still deferred — safe default remains "refuse if `ψ/` present." #588 stays open until the remaining three land.

## (i) Final PR — `--seed` + `--sync-peers` (file-copy pair)

Closes the file-copy pair deferred from #611. After this PR all 8 TODOs from #591 are shipped and #588 can close.

### `--seed` semantics

When `--seed` and `--from <parent>` are both set on `--from-repo`, copy the parent oracle's `ψ/memory/` tree into the target's `ψ/memory/` at bud time. Mirrors the existing `cmdBud` behavior (`bud-wake.ts` step 5) where `--seed` triggers a bulk soul-sync from parent.

- **Source resolution**: `<ghqRoot>/<org>/<parent>-oracle/ψ/memory`. `ghqRoot` and `org` come from `loadConfig()` (same fallback chain as `cmdBud`: `--org` / `config.githubOrg` / `"Soul-Brews-Studio"`). For `--from-repo` we don't expose `--org`, so this PR resolves `org` as `config.githubOrg || "Soul-Brews-Studio"`.
- **Destination**: `<target>/ψ/memory` — already created by `writeVault` earlier in the exec sequence.
- **Copy semantics**: `fs.cpSync(src, dst, {recursive: true, errorOnExist: false, force: false})`. `force: false` means a pre-existing child file is NOT overwritten ("Nothing is Deleted"). `errorOnExist: false` means we don't throw on conflicts — just skip per-file. The result is a union-merge biased to the child's existing content.
- **Failure mode**: If parent's `ψ/memory/` doesn't exist (new parent, fresh fleet), log a warning and skip — mirrors `finalizeBud`'s "soul-sync seed failed (parent may have empty ψ/)" handling. Never blocks the injection.
- **No `--from`?**: `--seed` alone is a warning and no-op — there's no parent to seed from. The planner surfaces this so `--dry-run` tells the user.
- **URL-mode**: `--seed` still works because parent resolution is LOCAL (via ghqRoot/org/<parent>-oracle) — the URL target is independent of parent source.

### `--sync-peers` semantics

When `--sync-peers` is set, copy the host's `peers.json` (the `~/.maw/peers.json` / `$PEERS_FILE` / `$MAW_HOME/peers.json` file — parent and child share the same file on a single host) into the TARGET REPO as a portable seed at `<target>/ψ/peers.json`.

Why a file inside the target repo rather than mutating `~/.maw/peers.json`? Three reasons:

1. **Same-host degenerate case**: On one machine, parent's `~/.maw/peers.json` IS child's `~/.maw/peers.json`. A literal copy is a no-op. Writing into `<target>/ψ/peers.json` makes the operation meaningful — it creates a portable snapshot that travels WITH the target repo.
2. **Non-destructive**: We never touch `~/.maw/` — respects the principle that scaffolding only writes under `<target>`. Operators who clone the target on a different host can `maw peers import <target>/ψ/peers.json` (or a future bootstrap hook reads it) to materialize the peers locally.
3. **"Inherit parent's peer contacts" spirit**: The target repo carries the inherited peer list with it. When the new oracle wakes (even on a new host), the peer contacts are discoverable from the vault.

- **Source**: `peersPath()` from `src/commands/plugins/peers/store.ts` (already handles `PEERS_FILE` / `MAW_HOME` / default). Resolved at runtime.
- **Destination**: `<target>/ψ/peers.json`. Created alongside the vault — `ψ/` is already mkdir'd.
- **Missing source**: If no `peers.json` exists on the host, log a skip and move on.
- **Idempotency**: Overwrite is safe — the file is a snapshot, not mutable per-host state. Re-running produces the same content (modulo `lastSeen` timestamp drift).

### Flag wiring

- `index.ts`: `--seed` is already parsed (for native `cmdBud`). Route it into `FromRepoOpts.seed` when `--from-repo` is set. Add a new `--sync-peers` boolean and route into `FromRepoOpts.syncPeers`. Usage line updated.
- `types.ts`: `FromRepoOpts` gains `seed?: boolean` and `syncPeers?: boolean`.
- `from-repo.ts`: planner reflects the two new actions:
  - `mkdir/write: ψ/memory/ (seed from <parent>)` — `kind: "write"`, reason `--seed`
  - `write: ψ/peers.json (from <peersPath>)` — `kind: "write"`, reason `--sync-peers`
  Orchestrator calls new executor entry points after `applyFromRepoInjection` (seed + peers live AFTER vault mkdir, so ψ/memory already exists).
- `from-repo-exec.ts`: gains `seedFromParent` and `copyPeersSnapshot` helpers. Both tolerate missing sources.

### Parent resolution — small, focused

- Does NOT shell out.
- Does NOT clone the parent repo.
- Pure function of `ghqRoot + org + parentStem` from `loadConfig()` — the parent's `ψ/memory/` must already be on disk locally. If it isn't, --seed is a warning + skip. Same contract as `cmdBud`'s `cmdSoulSync` call (which also reads parent's local ψ/).

### Test additions

Hermetic, real-fs where possible:

- `--seed` copies parent's ψ/memory/ contents (set up a fake parent tree under a tmp `ghqRoot`, mock `loadConfig` to point there, assert copied files appear in target).
- `--seed` without `--from`: log warning, no copy.
- `--seed` with missing parent vault: log skip, injection still completes.
- `--sync-peers` copies `peers.json` to `<target>/ψ/peers.json` (use `PEERS_FILE` env override to point at a tmpfile).
- `--sync-peers` without source peers.json: skip, no file written.
- Planner reflects `--seed` + `--sync-peers` as `write` actions.
- `--seed` biased to destination: pre-existing target-side file is NOT overwritten (force:false).

### File layout — this PR

- `src/commands/plugins/bud/types.ts` — add `seed?`, `syncPeers?` fields.
- `src/commands/plugins/bud/from-repo.ts` — planner emits new actions; orchestrator calls new exec helpers.
- `src/commands/plugins/bud/from-repo-exec.ts` — new `seedFromParent` + `copyPeersSnapshot` (~80 LOC combined).
- `src/commands/plugins/bud/index.ts` — add `--sync-peers` flag, route `--seed` into `FromRepoOpts`.
- `src/commands/plugins/bud/from-repo.test.ts` — new describe block.
- `docs/bud/from-repo-impl.md` — this section.

All files remain ≤250 LOC post-change.

## (h) Continuation PR — `--force` + `--track-vault` + fleet entry + `--from` lineage

The remaining six TODOs from #591 split into a "light quad" (this PR) and a "file-copy pair" (deferred):

| # | TODO              | Continuation | Defer | Reason |
|---|-------------------|--------------|-------|--------|
| 1 | `--force`         | ✅           | —     | Tiny — flip a planner blocker into a warning + `overwrite` action |
| 2 | Fleet entry       | ✅           | —     | Reuse `configureFleet` from `bud-init.ts`; isolate behind a thin module so tests can mock |
| 3 | `--from` lineage  | ✅           | —     | Embed `<!-- oracle: budded from <parent> -->` + lineage line in CLAUDE.md template/append |
| 4 | `--track-vault`   | ✅           | —     | Default = add `ψ/` to target's `.gitignore`; `--track-vault` skips that |
| 5 | `--seed`          | —            | ✅    | Requires soul-sync file-copy from parent — needs separate scope |
| 6 | `sync_peers`      | —            | ✅    | Same — depends on parent peers.json + #589 work |

After this PR cumulatively 8 of 8 TODOs from #591 are shipped except `--seed` + `sync_peers`. #588 stays open until those land.

### `--force` semantics

Today the planner emits a hard blocker if `ψ/` already exists in the target. With `--force`:

- The blocker downgrades to an `overwrite` action (same kind: `mkdir`, but a `force` reason annotation is attached for the planner-format output).
- `mkdirSync({recursive: true})` is already idempotent on the directories themselves, so no destructive write of the existing tree happens — we never `rmSync` `ψ/`. `--force` only suppresses the *refusal*; it does not blow away pre-existing memory. (Aligns with "Nothing is Deleted".)
- CLAUDE.md is unaffected by `--force` — it remains idempotent via the marker, and the executor still appends a new block if no marker is present (which is the normal append-on-existing-CLAUDE.md path). If the user wants to inject a SECOND oracle scaffold under a different stem, that already works without `--force` (stem-scoped marker).
- `.claude/settings.local.json` continues to be left untouched if it exists.

In short, `--force` means "don't refuse on the ψ/ collision blocker." Nothing more, nothing less.

### Fleet-entry module — `from-repo-fleet.ts`

Reuse the existing `configureFleet` from `bud-init.ts`? No — `configureFleet` takes `org` and `budRepoName` derived from the parent's bud flow. For `--from-repo` we instead derive the slug from the *target* repo:

1. Read `git -C <target> remote get-url origin` to extract the `org/repo` slug. If no remote exists (rare, fresh local repo), fall back to using the target dir basename and emit a warning — fleet entry still gets written but with `repo: "<unknown>/<basename>"`.
2. Write `<NN>-<stem>.json` to `FLEET_DIR` using the same idempotent shape as `configureFleet` (load existing entries, find next NN, write JSON with `windows` + `sync_peers: []`, plus `budded_from`/`budded_at` if `--from` was given).

Lives in a dedicated module so:
- Tests can `mock.module("./from-repo-fleet", …)` to prove the planner+executor wire it up correctly without touching real `~/.config/maw/fleet/`.
- The module is the only place that reads `FLEET_DIR` from `core/paths.ts`, so future moves of fleet storage only touch one file.

### `--from <parent>` lineage in CLAUDE.md

Two effects, both in the executor:

1. Full-write path (no existing CLAUDE.md): include the `Budded from: <parent>` lineage field in the identity block. Mirrors the existing `bud-init.ts:generateClaudeMd` shape.
2. Append-under-marker path (existing CLAUDE.md): the appended block adds an `Origin: budded from <parent>` bullet inside the fenced section.

A machine-readable HTML comment also goes inside the fence: `<!-- oracle-lineage: parent=<parent> -->`. Used by future tooling (`maw soul-sync --from`, `maw fleet`) to detect lineage without re-parsing markdown prose.

If `--from` is omitted, no lineage line is emitted (current behavior preserved).

### `--track-vault` semantics + `.gitignore`

Today the executor does not touch `.gitignore`. Default behavior changes to:

1. After successful injection, append `ψ/` to the target's `.gitignore` (creating the file if absent). Idempotent — if `^ψ/$` already matches a line, skip.
2. `--track-vault` set: skip the `.gitignore` step. ψ/ becomes a tracked part of the host repo.

Why default-ignore rather than default-track? Most existing repos that are getting the bud-into-existing-repo treatment will not want the entire memory vault checked in alongside source. Federation already has Vault sync (per memory entry on `vault sync scope`), so the default keeps the host repo's git history clean. Operators who *want* to track ψ/ opt in explicitly.

### Test additions

- `--force` allows ψ/ collision: `mkGitRepo` → pre-create `ψ/` → call with `force: true` → expect injection completes, CLAUDE.md exists.
- `--from <parent>` writes lineage marker: assert CLAUDE.md contains both `Budded from: <parent>` and the `oracle-lineage` HTML comment.
- `--track-vault` controls `.gitignore`: default run adds `ψ/`; `trackVault: true` does not.
- Fleet wiring: mock `from-repo-fleet.ts` and assert the `register` function is called with `{stem, repoSlug, parent}` after a successful injection.

### File layout — continuation PR

- `src/commands/plugins/bud/types.ts` — extend `FromRepoOpts` with `force?: boolean`, `from?: string`, `trackVault?: boolean`.
- `src/commands/plugins/bud/from-repo.ts` — planner: respect `--force` (downgrade ψ/ blocker), reflect lineage + .gitignore actions; orchestrator: invoke fleet register after executor.
- `src/commands/plugins/bud/from-repo-exec.ts` — executor: lineage in CLAUDE.md (full-write + append-block), `.gitignore` write (default), pass-through of `force` (no destructive ops).
- `src/commands/plugins/bud/from-repo-fleet.ts` — **new**. `registerFleetEntry({stem, target, parent})`. Reads remote, computes slug, writes `<NN>-<stem>.json` to `FLEET_DIR`. ≤100 LOC.
- `src/commands/plugins/bud/index.ts` — wire new flags: `--force`, `--from` (only when `--from-repo` is set), `--track-vault`.
- `src/commands/plugins/bud/from-repo.test.ts` — new test cases per above.

All files ≤200 LOC.

## (b) File-write sequencing

Non-transactional — but **fail-fast + fail-before-mutate**:

1. Re-run `planFromRepoInjection` under the executor. If blockers surfaced by the planner are present, refuse (no writes).
2. Write in order: `ψ/` dirs → `.claude/settings.local.json` → `CLAUDE.md` (write or append).
3. If any step throws mid-run, we leave whatever landed behind and surface the error — the caller can `rm -rf ψ/` to recover. We do NOT try to roll back; partial state is better than silent deletion of pre-existing host-repo content. (Aligns with "Nothing is Deleted".)

`ψ/` is mkdir-first because it's the biggest/slowest op and the most likely to fail (permissions on host repos). If it fails we never touch CLAUDE.md.

## (c) URL clone strategy

Shallow-clone to an OS tmpdir, then delegate to the local-path executor. On exit — success or failure — the tmpdir is `rmSync`'d.

- Detection: `looksLikeUrl` matches `https://`, `http://`, `git@…`, and `org/repo` slugs.
- Clone: `git clone --depth 1 <url> <tmp>` via `hostExec`. If clone fails, the tmpdir is removed and the error bubbles. (We do NOT reuse the `ensureCloned` / `ghq get` path here because those seat the clone in `~/ghq` where the operator might later tab-complete into a half-scaffolded directory — ephemeral is safer.)
- On URL the flow *always* opens a PR: the tmpdir gets thrown away, so committing-only would be wasted work. `--pr` is implied when the target is a URL; it's still accepted explicitly for symmetry.

Git/gh calls live in a dedicated module (`from-repo-git.ts`) so tests can swap them out via `mock.module("./from-repo-git", …)`. The orchestrator never shells out directly — keeps `from-repo.ts` pure/testable-without-shell.

## (d) CLAUDE.md append shape + idempotency

Appended block is fenced with HTML-comment markers:

```
<!-- oracle-scaffold: begin stem=<stem> -->
## Oracle scaffolding

> Budded into this repo on <YYYY-MM-DD>
...Rule 6 summary + identity pointer...
<!-- oracle-scaffold: end stem=<stem> -->
```

Idempotency: on re-run the executor greps for `<!-- oracle-scaffold: begin stem=<stem> -->`. If present, the CLAUDE.md step is a no-op with a `○ skip` log line. Stem-scoped, so if a repo later gets re-seeded under a different stem (rare but legal), we append a new block.

## (e) Collision handling

Executor re-uses the planner: anything the planner flags as a blocker is a hard stop (throw → handler returns `{ ok: false }`). Specifically:
- `ψ/` already present → throw, match planner message.
- Target not a git repo → throw.
- URL target → clone to tmpdir, then the tmpdir is the `target` the planner sees (so the normal blockers still apply — e.g. if a repo already has `ψ/`, the PR flow refuses the same way).

No `--force` in this PR. Defer.

## (g) `--pr` flow

After a successful local-path injection we open a PR on the target repo:

1. `git checkout -b oracle/scaffold-<stem>` — branch name is deterministic + predictable for re-runs. If the branch already exists (rare — would mean a prior aborted run), `checkout -b` fails and the error surfaces; operator decides whether to `git branch -D` and retry.
2. `git add -A` then `git commit -m 'oracle: scaffold from maw bud --from-repo'`.
3. `git push -u origin oracle/scaffold-<stem>`.
4. `gh pr create --fill --head oracle/scaffold-<stem>` — `--fill` uses the commit message as the PR title/body. gh auto-detects the target repo from `origin`. The returned URL is echoed to the log.

No cleanup of the local branch on failure — the operator owns git state and may want to fix + retry. Tmpdir (URL-mode) *is* cleaned up unconditionally.

## (f) Test strategy

Real-fs integration tests, no mocks:

1. `mkdtempSync(tmpdir())` + manual `mkdir .git` for a fake git repo.
2. Drive `cmdBudFromRepo({dryRun: false})` end-to-end.
3. Assert on disk: `existsSync(ψ/inbox)`, `readFileSync(CLAUDE.md)` contains the marker, contents of `.claude/settings.local.json` parse as `{}`.
4. Idempotency test: run twice, second run leaves CLAUDE.md char-count unchanged.
5. Collision test: pre-create `ψ/` → expect throw containing `already present`.
6. `finally { rmSync(dir, {recursive:true, force:true}) }` for cleanup — same pattern as existing `from-repo.test.ts`.

## File layout

- `src/commands/plugins/bud/from-repo.ts` — planner + orchestrator. Removes the URL blocker; clones URL targets via `from-repo-git.ts`, then re-invokes planner on the tmpdir. Invokes `--pr` path after the executor when requested. ≤200 LOC.
- `src/commands/plugins/bud/from-repo-exec.ts` — executor: `applyFromRepoInjection`. Unchanged for local-path writes; stays ≤200 LOC.
- `src/commands/plugins/bud/from-repo-git.ts` — **new**. Thin wrappers over `hostExec` for `cloneShallow`, `branchCommitPushPR`, `cleanupClone`. Only module that shells out for git/gh. Kept small (<100 LOC) so tests can `mock.module` it cleanly.
- `src/commands/plugins/bud/from-repo.test.ts` — add URL-mode tests (mock git helper) + `--pr` tests (mock git helper).

Planner stays pure. Executor only writes files. All shell-outs for git/gh live in one place.
