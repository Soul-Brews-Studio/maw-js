# Handoff: Mega maw-js Session — 25+ PRs

**Date**: 2026-03-15 02:15
**Context**: 95%+ (ยาวมาก ข้ามวัน)

## What We Did

### Infrastructure (PRs #22, #27)
- `--continue` fallback + direnv preload in `buildCommand()`
- `maw wake all --resume` — auto-recovery after reboot
- `maw-boot` PM2 process for fleet auto-start
- CLI refactored: all commands moved to `src/commands/`

### Dead Oracle Detection (PRs #28, #29)
- `maw ls` shows process status (green/blue/red dots)
- Detects deleted working directories via tmux `#{pane_current_path}`

### Football Pitch (PRs #33-55)
- 5-5-5 formation with macOS Dock magnification (CSS transform scale)
- Super Saiyan 2x (104px) for busy agents
- Top 5 recent = colored (64px), rest = grey (52px)
- Stage/Pitch toggle (persisted in Zustand)
- Names always colored, only avatars go grey

### Feed Resolver Fix (PR #59)
- `calliope-oracle` → `calliope-oracle-oracle` bug — double suffix
- Now handles both `oracle="neo"` and `oracle="calliope-oracle"` formats

### Bug Fixes (PRs #60-69)
- #60: `maw done` exact worktree match (not substring)
- #62: `maw wake` deletes stale branches before creating worktree
- #64: `sendText` uses `-l` (literal) — preserves pipe chars in markdown
- #67-69: Double Enter with 1s delay for Claude Code input processing

### Logging & Version (PRs #70-75)
- Built-in JSONL logging: `~/.oracle/maw-log.jsonl` (ts, from, to, target, msg, host, sid)
- `maw --version` → `maw v1.1.0 (hash)`
- `maw log ls` + `maw log export --date YYYY-MM-DD`
- Facebook Page pipeline "AI คุยกันเอง | Build with Oracle" started

### Sibling Collaboration
- Hermes: 5 dead worktrees cleaned, relay confirmed solid
- Odin: Vector DB pruning design → oracle-v2#381 (getStaleDocumentIds + deleteByIds)
- Calliope: Working hours analysis, logging design approval, version check
- Pulse: PM coordination, issue creation, bug reports

## Pending
- [ ] #74 — maw log threads (group conversations by from↔to pairs)
- [ ] oracle-v2#381 — Vector DB pruning (Odin's interface design ready)
- [ ] Stale branch `feat/log-sid` to delete
- [ ] `src/hooks.ts` untracked file (from hook system, may not be needed)
- [ ] #26 partially fixed by #62, may need closing
- [ ] Preview card 700px — may need iPad testing

## Next Session
- [ ] Implement #74 (maw log threads) — group conversations for blog content
- [ ] Pick up oracle-v2#381 — delete legacy lance collection, implement prune
- [ ] Clean stale branches
- [ ] Close resolved issues (#25, #26)
- [ ] Calliope starts using `maw log export` for Facebook content

## Key Files
- `src/commands/comm.ts` — maw hey + logging
- `src/commands/log.ts` — maw log ls/export (NEW)
- `src/tmux.ts` — sendText literal + double Enter
- `src/commands/done.ts` — exact worktree match
- `src/commands/wake.ts` — stale branch deletion
- `src/config.ts` — buildCommand with --continue fallback + direnv
- `office/src/components/FootballPitch.tsx` — formation view (NEW)
- `office/src/hooks/useSessions.ts` — feed resolver fix
- `office/src/lib/store.ts` — stageMode toggle
