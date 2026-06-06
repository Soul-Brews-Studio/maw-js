# Codex branch cleanup audit (#2315)

Date: 2026-06-06

## Summary

- Fetched `origin/alpha` and pruned stale remote-tracking refs before classification.
- Skipped `release/*` branches entirely.
- Queried GitHub branches and PRs with `gh api`.
- Deleted only local-repo `codex-*` branches with merged PR evidence and no patch-unique commits relative to `origin/alpha` (`git cherry origin/alpha <sha>` emitted only `-`).
- Did not delete active PR heads, branches with no merged PR evidence, or branches with patch-unique commits.

> Note: GitHub squash merges leave `git log origin/alpha..<branch>` non-empty even when the patch is present on `alpha`. Those branches were treated as safe only when both merged PR evidence and `git cherry` patch-equivalence agreed. No branch was deleted solely from PR state.

## Counts

- deleted_patch_equivalent: 9
- skip_active_pr: 1
- skip_no_merged_pr: 24
- skip_patch_unique: 3
- remaining codex/agents-codex branches after cleanup: 27

## Deleted branches

- `codex-1-2250-cross-team-queue-standalone` — merged PR(s) #2258; alpha..branch has 1 commits; git cherry all patch-equivalent (-) (887c9b49eb0b)
- `codex-1-demo-standalone` — merged PR(s) #2264; alpha..branch has 2 commits; git cherry all patch-equivalent (-) (da02ac9cbeec)
- `codex-1-on-standalone` — merged PR(s) #2273; alpha..branch has 1 commits; git cherry all patch-equivalent (-) (e2076fabe391)
- `codex-2-2251-assign-standalone` — merged PR(s) #2259; alpha..branch has 1 commits; git cherry all patch-equivalent (-) (5fcbfd88f084)
- `codex-2-2283-pulse-standalone` — merged PR(s) #2294; alpha..branch has 1 commits; git cherry all patch-equivalent (-) (7bceb89323c1)
- `codex-2-cross-team-queue-standalone` — merged PR(s) #2266; alpha..branch has 1 commits; git cherry all patch-equivalent (-) (1b845161a49a)
- `codex-2-scope-standalone` — merged PR(s) #2299; alpha..branch has 1 commits; git cherry all patch-equivalent (-) (bf13cb648516)
- `codex-5-2191-capture-standalone` — merged PR(s) #2196; alpha..branch has 1 commits; git cherry all patch-equivalent (-) (930833b26a58)
- `codex-5-costs-standalone` — merged PR(s) #2272; alpha..branch has 1 commits; git cherry all patch-equivalent (-) (b5d55ff2fdcd)

## Needs review: merged PR but patch-unique commits remain

- `codex-3-investigate-2165-ledger-retention` — merged PR(s) #2176; alpha..branch has 1 commits; git cherry has 1 patch-unique commits (+) (3da351e61ff3)
- `codex-5-2157-sdk-messages-exports` — merged PR(s) #2162; alpha..branch has 1 commits; git cherry has 1 patch-unique commits (+) (80ce2e08cf6c)
- `codex-6-2206-remaining-mocks` — merged PR(s) #2214; alpha..branch has 2 commits; git cherry has 1 patch-unique commits (+) (a4a16479bfaf)

## Skipped active PR heads

- `codex-3-test-2221-absorb-standalone` — open PR #2339 (70d9b120411b)

## Skipped: no merged PR evidence

- `agents/codex-align-coverage-extractions` — no merged PR found for head ref (a032b1472987)
- `agents/codex-pr-2288-channel-standalone` — no merged PR found for head ref (1d64078c31d3)
- `codex-1-2113-signals-standalone` — no merged PR found for head ref (1f2d48ec501b)
- `codex-1-2192-follow-standalone` — no merged PR found for head ref (ca4cb76d1060)
- `codex-1-2219-archive-standalone` — no merged PR found for head ref (432df4370f07)
- `codex-1-2221-absorb-standalone` — no merged PR found for head ref (bce85b8087cd)
- `codex-1-2226-check-standalone` — no merged PR found for head ref (480769a95eb0)
- `codex-1-fix-2206-batch2` — no merged PR found for head ref (ca2f576de5c7)
- `codex-1-fix-2206-three-coverage` — no merged PR found for head ref (1d6fc049311b)
- `codex-1-oracle-skills-standalone` — no merged PR found for head ref (c8975fb6a68f)
- `codex-1-p0-final-5-tests` — no merged PR found for head ref (f12a02da358b)
- `codex-2-plugin-command-standalone` — no merged PR found for head ref (a032b1472987)
- `codex-3-p0-ui-capture-mocks` — no merged PR found for head ref (90cae5818ff1)
- `codex-3-rebase-2178-wake-drain` — no merged PR found for head ref (87cf4de51c0c)
- `codex-3-test-2252-check-standalone` — no merged PR found for head ref (a95d25b12513)
- `codex-3-test-overview-standalone` — no merged PR found for head ref (240b27bf4e99)
- `codex-5-2145-wake-rehydrate-sources` — no merged PR found for head ref (0802b436e93a)
- `codex-5-2225-attach-ssh-standalone` — no merged PR found for head ref (ffaa797dda9e)
- `codex-5-2247-avengers-standalone` — no merged PR found for head ref (a76ebf0eb80e)
- `codex-5-run-standalone` — no merged PR found for head ref (d9df3a33ae46)
- `codex-6-2113-broadcast-extraction` — no merged PR found for head ref (1dced208479c)
- `codex-6-2206-mock-alignment` — no merged PR found for head ref (230a7aa2d8ad)
- `codex-6-calver-mock-align-4` — no merged PR found for head ref (ed2346fcca43)
- `codex-6-workspace-standalone` — no merged PR found for head ref (7ac3be4e6989)

## Remaining codex refs after cleanup

- `agents/codex-align-coverage-extractions`
- `agents/codex-pr-2288-channel-standalone`
- `codex-1-2113-signals-standalone`
- `codex-1-2192-follow-standalone`
- `codex-1-2219-archive-standalone`
- `codex-1-2221-absorb-standalone`
- `codex-1-2226-check-standalone`
- `codex-1-fix-2206-batch2`
- `codex-1-fix-2206-three-coverage`
- `codex-1-oracle-skills-standalone`
- `codex-1-p0-final-5-tests`
- `codex-2-plugin-command-standalone`
- `codex-3-investigate-2165-ledger-retention`
- `codex-3-p0-ui-capture-mocks`
- `codex-3-rebase-2178-wake-drain`
- `codex-3-test-2252-check-standalone`
- `codex-3-test-overview-standalone`
- `codex-5-2145-wake-rehydrate-sources`
- `codex-5-2157-sdk-messages-exports`
- `codex-5-2225-attach-ssh-standalone`
- `codex-5-2247-avengers-standalone`
- `codex-5-run-standalone`
- `codex-6-2113-broadcast-extraction`
- `codex-6-2206-mock-alignment`
- `codex-6-2206-remaining-mocks`
- `codex-6-calver-mock-align-4`
- `codex-6-workspace-standalone`
