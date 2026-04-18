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
