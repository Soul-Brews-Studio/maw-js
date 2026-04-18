# `maw bud --from-repo` — implementation analysis (PR for #588)

Builds on `docs/bud/from-repo-design.md` + #591 scaffold. Scope: **local-path full run**.

## (a) 8-TODO scope — this PR vs deferred

From #591 body:

| # | TODO                                            | This PR | Defer |
|---|-------------------------------------------------|---------|-------|
| 1 | Actual fs writes (ψ/ + CLAUDE.md + .claude/)    | ✅ ship | —     |
| 2 | URL / `org/repo` resolution via `ensureCloned`  | —       | ✅    |
| 3 | `--pr` branch-and-PR flow                       | —       | ✅    |
| 4 | Fleet entry creation (`configureFleet`)         | —       | ✅    |
| 5 | CLAUDE.md append idempotency marker             | ✅ ship | —     |
| 6 | Optional `--from <parent>` lineage in CLAUDE.md | —       | ✅    |
| 7 | Optional `--seed` soul-sync from parent         | —       | ✅    |
| 8 | Parent `sync_peers` update when `--from` given  | —       | ✅    |

Three of eight shipped (1, 5, partial of what #591 called out); five deferred to follow-ups. #588 stays open.

## (b) File-write sequencing

Non-transactional — but **fail-fast + fail-before-mutate**:

1. Re-run `planFromRepoInjection` under the executor. If blockers surfaced by the planner are present, refuse (no writes).
2. Write in order: `ψ/` dirs → `.claude/settings.local.json` → `CLAUDE.md` (write or append).
3. If any step throws mid-run, we leave whatever landed behind and surface the error — the caller can `rm -rf ψ/` to recover. We do NOT try to roll back; partial state is better than silent deletion of pre-existing host-repo content. (Aligns with "Nothing is Deleted".)

`ψ/` is mkdir-first because it's the biggest/slowest op and the most likely to fail (permissions on host repos). If it fails we never touch CLAUDE.md.

## (c) URL clone strategy

Deferred. URL targets still hit the planner blocker from #591 (`not yet supported`). The executor never sees them — `cmdBudFromRepo` short-circuits on `plan.blockers.length > 0` before reaching the executor.

Follow-up PR: wire `ensureCloned` from `shared/wake-target` (already exists for `maw wake`), resolve URL → local path → call executor.

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
- URL target → throw with pointer to follow-up PR.

No `--force` in this PR. Defer.

## (f) Test strategy

Real-fs integration tests, no mocks:

1. `mkdtempSync(tmpdir())` + manual `mkdir .git` for a fake git repo.
2. Drive `cmdBudFromRepo({dryRun: false})` end-to-end.
3. Assert on disk: `existsSync(ψ/inbox)`, `readFileSync(CLAUDE.md)` contains the marker, contents of `.claude/settings.local.json` parse as `{}`.
4. Idempotency test: run twice, second run leaves CLAUDE.md char-count unchanged.
5. Collision test: pre-create `ψ/` → expect throw containing `already present`.
6. `finally { rmSync(dir, {recursive:true, force:true}) }` for cleanup — same pattern as existing `from-repo.test.ts`.

## File layout

- `src/commands/plugins/bud/from-repo.ts` — planner unchanged. Orchestrator updated to delegate to executor when `!dryRun`. Stays ≤200 LOC.
- `src/commands/plugins/bud/from-repo-exec.ts` — **new**. Pure executor: `applyFromRepoInjection(plan, opts): Promise<void>`. ≤200 LOC.
- `src/commands/plugins/bud/from-repo.test.ts` — add executor tests alongside existing planner tests.

Planner stays pure (read-only). Executor is the only place that writes. Makes the split testable and makes future `--force`/`--pr` flags land cleanly.
