# `maw team` Usage Telemetry — 2026-04-28 snapshot

Cross-fleet `/dig --deep` of `~/.claude/projects/**/*.jsonl` for "maw team" mentions, run from `mawjs-2-oracle` on 2026-04-28 21:08 +07.

**Methodology:** `grep -rl "maw team" ~/.claude/projects/ --include="*.jsonl"` → group by encoded-pwd project dir → aggregate session count + hits → sort by hits.

## Coverage

| Metric | Value |
|---|---|
| Total .jsonl files matching | 71 |
| Distinct projects | 23 |
| Earliest appearance | 2026-03-25 09:34 (`laris-co/neo-oracle/wt-3-maw-js`, session `agent-ac`) |
| Latest appearance | 2026-04-28 21:08 (multiple) |
| Span | ~5 weeks |

## Top projects by activity

| Rank | Project | Sessions | Total hits |
|---|---|---|---|
| 1 | `Soul-Brews-Studio/mawjs` (parent oracle) | 22 | **287** |
| 2 | `Soul-Brews-Studio/mawjs-2` | 4 | 80 |
| 3 | `laris-co/neo-oracle/wt-3-maw-js` (worktree) | 8 | 67 |
| 4 | `-Users-nat` (Nat's home dir) | 2 | 33 |
| 5 | `Soul-Brews-Studio/arra-oracle-v3` | 6 | 25 |
| 6 | `laris-co/neo` | 5 | 22 |
| 7 | `Soul-Brews-Studio/home-comming` | 4 | 7 |
| 8 | `laris-co/white-wormhole` | 2 | 4 |
| 9 | `laris-co/openclaw-learner` | 2 | 4 |
| 10 | `ARRA-01-hojo` | 2 | 3 |

(Long tail: 13 more projects with 1–2 hits each.)

## Observations

1. **Adoption concentrated in parent oracle** — 287 hits across 22 sessions, 4× more than next project. The feature lives where its developer lives.

2. **Cross-fleet adoption is shallow** — federation peers (m5-keeper, pulse, white-wormhole) have 1–4 hits each, mostly contextual. `maw team` is being **built** extensively but **not yet exercised across the federation** as a multi-oracle coordination tool.

3. **`oracle-invite` may be underused in practice** — the cross-oracle persistent-membership path (the killer differentiator vs `team-agents` per `docs/comparison/team-agents-vs-maw-team.md`) doesn't appear to have heavy adoption based on these mention patterns.

4. **Worktree development pattern** — `laris-co/neo-oracle/wt-3-maw-js` (67 hits, 8 sessions) shows feature dev happens in a worktree of `neo-oracle` then merges back. First `maw team` mention (2026-03-25) was in this worktree — birth date.

5. **arra-oracle-v3 integration thread exists** — 25 hits across 6 sessions suggests arra MCP × maw team as its own active subthread.

## Implication

Dogfooding the federation differentiator (`oracle-invite` for cross-oracle persistent members) hasn't happened at scale yet. Most usage is single-host dev/test. Future work to exercise: spin team with `oracle-invite m5-wormhole` + `oracle-invite m5-keeper` and measure cross-fleet message flow.

## Source
- Audit run: mawjs-2-oracle, 2026-04-28 21:08 +07
- Issue: #821 (now closed)
- Companion comparison: `docs/comparison/team-agents-vs-maw-team.md` (#814)
