# maw wake + worktree lifecycle — 31 day evolution

> 20 LOC → 1,729 LOC. spawn(3d) → deleted → hardened → federation → bud splits off.
> The attach fix was 3 lines after 1,726 lines of everything else.

```
MAW WAKE + WORKTREE LIFECYCLE — 31 DAY TIMELINE
════════════════════════════════════════════════

MAR 10 (Day 1) ──── BIRTH
  12:04  8f52273  + maw spawn (worktree-based tmux sessions)
  17:15  e97d7ee  + maw wake born (resolveOracle, findWorktrees, cmdWake)
  17:45  be9070a  + recap-first wake + named worktree flag
  17:47  da01e64  + reuse existing worktrees (don't always create new)
  18:06  2b01eb6  + spawn all worktree windows in new session
  18:06  a04b492  ~ fix: full worktree suffix for window names
  23:27  5404074  ~ fix: main window named <oracle>-oracle
  23:58  48bfb61  + maw oracle ls — fleet status with worktree count
         ·····    ~60 LOC. wake = "find repo, make tmux, start claude"

MAR 11 ──── FLEET SCALE
  00:18  96907d0  + maw wake all / maw sleep — bulk fleet management
  00:26  b9efcc8  ~ robust fleet wake (try/catch)
  01:20  0d10e66  + wake --issue flag
  17:08  a451a8f  + spawn/stop/wake controls in Fleet UI
  17:15  da290cf  + slept agents render grey + wake button
         ·····    wake goes from single-agent to fleet-wide

MAR 12 ──── FIRST BUG
  08:52  b2aa491  ~ spawn crash when tmux base-index=1 (#13)
  08:53  5daa148  ~ PR #13 merged
         ·····    tmux assumptions break on non-default configs

MAR 13 ──── ★ SPAWN DELETED ★
  05:13  5cb4127  ~ drop --continue on fresh worktrees
  20:29  19bb5f2  ✂ maw spawn REMOVED. 26 fleet configs rebuilt.
                    per-oracle sessions replace grouped sessions.
                    spawn.ts (47 lines) deleted.
  20:57  75adf65  ~ worktrees added back to fleet configs (survived)
  21:39  7bfad7c  + maw done born (worktree cleanup lifecycle)
  21:53  35edfab  ~ done: prune worktrees + delete branches
         ·····    3-day spawn era ends. wake inherits everything.

MAR 14 ──── HARDENING DAY (3 fixes)
  07:19  14f73cd  ~ wake: no duplicate windows (fleet naming)
  07:27  c4d996e  ♻ wake.ts → Tmux class (no more raw ssh)
  11:21  361e008  + worktree hygiene dashboard — scan/classify/cleanup (#20)
  15:16  ef2ae15  ~ done: EXACT worktree match, not substring (#60)
                    (substring matching deleted wrong worktrees!)
  15:26  e7c95ed  ~ wake: delete stale branch before worktree add (#62)
         ·····    the "sharp edges" week begins

MAR 15 ──── SLEEP BORN
  20:40  ae54692  + maw sleep <oracle> [window] — single shutdown (#76)
  21:46  77914b5  ~ sleep: require oracle name (safety)
         ·····    lifecycle now has: wake → work → sleep → wake

MAR 17
  12:33  1463af2  + signal inbox for worktree notifications (#81)
         ·····    worktrees can signal their parent

MAR 20 ──── BIGGEST DAY (4 commits)
  17:29  32de037  + wake RESPAWNS missing worktrees after reboot (#89)
                    +31 lines: scan .wt-* dirs, recreate windows
  17:38  77c025c  ♻ replace ALL raw ssh('tmux...') with Tmux wrapper
  17:59  f160104  ♻ strip number prefix from window names (#91)
                    "neo-17-mawjs" → "neo-mawjs"
  18:41  a376c5d  ~ wake ensures Claude runs in ALL windows (#95)
                    detect idle zsh panes, resend buildCommand
         ·····    wake becomes SELF-HEALING. survives reboots.

MAR 22 ──── MULTI-USER
  08:40  0783930  + wake accepts prompt as 3rd arg
  21:36  f20ca7c  + multi-user shared tmux socket
  23:18  354f25e  + auto-fix socket ACL permissions
  23:29  30930ae  ↩ revert setfacl (doesn't work for tmux)
         ·····    failed experiment, reverted same day

MAR 25-26 ──── LIFECYCLE POLISH
  21:55  19dffa6  + 7 new CLI commands + completions
  13:43  cc9044b  + tab order + fleet sync + orphan detect + done upgrade
  13:48  acdd6f3  + incubate + federation + lifecycle commands
  14:06  048b205  + HTTP federation + lifecycle commands
         ·····    wake ecosystem grows: tab-order.ts born

MAR 29 ──── ★ FEDERATION WAKE ★
  11:46  09a4a61  + wake checks WireGuard PEERS when oracle not found
                    +35 lines: fetch /api/sessions from each peer,
                    if found → send /api/send to wake remotely
  11:55  f7c26b0  ~ federation: match session name containing oracle
  12:16  3c179bd  ~ federation: timeout 3s → 10s (WireGuard latency)
         ·····    wake crosses machine boundaries for the first time

MAR 30 ──── SNAPSHOTS
  11:25  5c202a1  + fleet time machine — snapshot.ts (145 lines)
                    capture all sessions on wake/sleep/done
                    ~/.config/maw/snapshots/YYYYMMDD-HHMMSS.json
  11:34  0825d48  + snapshots include node identity
  11:46  5de39ab  ~ snapshot filename includes seconds
  11:47  0ea0a3e  + keep 720 snapshots (~1 month)
         ·····    every lifecycle event is now auditable

APR 1 ──── HOOKS + CONFIG
  11:06  6cbfffa  ~ await scanTeams + sessionIds
  11:29  0e09874  + one-time hooks, new wake options (#171)
  12:52  8cdcc6d  ♻ externalize 120+ hardcoded defaults into config
         ·····    wake becomes configurable, not hardcoded

APR 6 ──── PRE-BUD CLEANUP
  19:52  6b92244  ~ cd into repo before Claude + fix duplicate respawn
  20:00  fdd8f02  ~ ensureSessionRunning uses cwdMap
  21:31  b74655f  ~ skip worktree loop when task specified
         ·····    wake stabilized for what comes next

APR 7 ──── ★ BUD BORN ★
  13:22  f4bd3fb  + maw bud + maw take + auto soul-sync (v1.7.1)
                    bud.ts (206 LOC) — yeast budding model
                    take.ts (72 LOC) — vesicle transport
                    auto soul-sync on maw done
  13:23  4d7ba24  ~ bud: fix repo path (ghqRoot includes github.com)
  18:49  0f4cef4  + fleet consolidate + ssh→hostExec rename + bud fix
         ·····    oracle creation splits off from wake.
                  wake = REVIVE. bud = CREATE.

APR 8
  07:12  b5928a6  + isPaneIdle() — check pgrep before retry (#196)
                    1 line: if (!(await isPaneIdle(target))) continue;
                    don't kill Claude that's mid-startup
         ·····    smarter idle detection

APR 9
  21:27  230394a  ~ sprint-1: 3 bugs fixed by parallel agent team
                    #173 (static file guard), #178 (findWindow index),
                    #206 (sleep trailing dash)
         ·····    wake/sleep ecosystem cleaned by agent team

APR 10 ──── ★ THE 3-LINE FIX ★
  11:12  dfc2c04  + tmux.switchClient(session) — ACTUALLY ATTACH (#219)
                    3 lines added to tmux.ts:
                      async switchClient(session: string) {
                        await this.tryRun("switch-client", "-t", session);
                      }
                    + 3 calls in wake.ts at each return point
  11:16  9705073  ⊕ merge origin/alpha (54 upstream commits)
  11:17  439d001  ~ bud: check repo existence before creation (#218)
         ·····    31 days. 1,729 lines. 8 files. 7 flags.
                  the most basic thing took the longest to notice.

════════════════════════════════════════════════
SYSTEM TODAY (1,729 lines, 8 files):

  wake.ts ·········· 215 LOC  orchestrator
  wake-resolve.ts ·· 128 LOC  oracle discovery
  worktrees.ts ····· 223 LOC  scan/classify/cleanup
  done.ts ·········· 231 LOC  graceful shutdown
  sleep.ts ········· 117 LOC  pause + tab save
  fleet.ts ········· 573 LOC  fleet-wide wake/sleep
  tab-order.ts ····· 97 LOC   window order persistence
  snapshot.ts ······ 145 LOC  audit trail

FLAGS: task, --new, --incubate, --issue/#N, --fresh, --no-attach, --list
```

— [white:mawjs-oracle], traced 2026-04-10
