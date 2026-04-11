export function usage() {
  console.log(`\x1b[36mmaw\x1b[0m — Multi-Agent Workflow

\x1b[33mUsage:\x1b[0m
  maw ls                      List sessions + windows
  maw peek [agent]            Peek agent screen (or all)
  maw hey <agent> <msg...>    Send message to agent (alias: tell)
  maw hey <oracle>:<win> <m>  Target a specific tab (e.g. mawjs:mawjs-dev)
  maw wire <agent> <msg...>   Send via federation (curl over WireGuard)
  maw wake <oracle> [task]    Wake oracle in tmux window + claude
  maw wake <oracle> --issue N Wake oracle with GitHub issue as prompt
  maw wake <oracle> --incubate org/repo  Clone repo + worktree
  maw fleet init              Scan ghq repos, generate fleet/*.json
  maw fleet init --agents     Reconcile config.agents from fleet + peers
                              (additive, add --dry-run to preview)
  maw fleet ls                List fleet configs with conflict detection
  maw fleet renumber          Fix numbering conflicts (sequential)
  maw fleet validate          Check for problems (dupes, orphans, missing repos)
  maw fleet sync              Sync repo fleet/*.json → ~/.config/maw/fleet/
  maw fleet sync-windows      Add unregistered windows to fleet configs
  maw wake all [--kill]       Wake fleet (01-15 + 99, skips dormant 20+)
  maw wake all --all          Wake ALL including dormant
  maw wake all --resume       Wake fleet + send /recap to active board items
  maw sleep <oracle> [window] Gracefully stop one oracle window
  maw stop                    Stop all fleet sessions
  maw about <oracle>           Oracle profile — session, worktrees, fleet
  maw oracle ls               Fleet status (awake/sleeping/worktrees)
  maw overview              War-room: all oracles in split panes
  maw overview neo hermes   Only specific oracles
  maw overview --kill       Tear down overview
  maw bud <name>               Bud new oracle from current (yeast model)
  maw bud <name> --from <o>   Bud from specific parent oracle
  maw bud <name> --root       Root oracle — no parent lineage (works from empty)
  maw bud <name> --root --repo org/project   Root + incubate into existing repo
  maw take <sess>:<win> [tgt] Move window to session (omit tgt = split to own session)
  maw archive <oracle>         Graceful oracle death (soul-sync → disable → archive)
  maw find <keyword>           Search ψ/memory/ across all oracles
  maw fleet health             Fleet health: dormancy, zombies, islands
  maw fleet doctor             Federation config doctor: collisions, orphan routes, stale peers
  maw fleet doctor --fix       Apply safe auto-fixes (dedupe/remove self-peer/add agents)
  maw fleet doctor --json      JSON output for CI (exit 2=error, 1=warn, 0=clean)
  maw fleet consolidate        Merge branches + push disabled oracles
  maw fleet consolidate --remove  Also delete .disabled configs after push
  maw done <window>            Auto-save (/rrr + commit + push) then clean up
  maw done <window> --force   Skip auto-save, kill immediately
  maw done <window> --dry-run Show what would happen
  maw reunion [window]         Sync ψ/memory/ from worktree → main oracle repo
  maw soul-sync                Sync current oracle ψ/ → all configured peers
  maw soul-sync <peer>         Sync current oracle ψ/ → specific peer
  maw soul-sync --from <peer>  Pull ψ/ from peer → current oracle
  maw soul-sync --project      Absorb project ψ/ → owning oracle (cell membrane)
  maw pulse add "task" [opts] Create issue + wake oracle
  maw pulse cleanup [--dry-run] Clean stale/orphan worktrees
  maw view <agent> [window]   Grouped tmux session (interactive attach)
  maw create-view <agent> [w] Alias for view
  maw view <agent> --clean    Hide status bar (full screen)
  maw tokens [--rebuild]      Token usage stats (from Claude sessions)
  maw tokens --json           JSON output for API consumption
  maw log chat [oracle]       Chat view — grouped conversation bubbles
  maw chat [oracle]           Shorthand for log chat
  maw workon <repo> [task]    Open repo in new tmux window + claude (alias: work)
  maw rename <tab#> <name>     Rename tab (auto-prefixes oracle name)
  maw park [window] [note]     Park current (or named) tab with context snapshot
  maw park ls                  List all parked tabs
  maw resume [tab#/name]       Resume a parked tab (sends context)
  maw inbox                    List recent inbox items
  maw inbox read [N]           Read Nth item (or latest)
  maw inbox write <note>       Write note to inbox
  maw tab                      List tabs in current session
  maw tab N                    Peek tab N
  maw tab N <msg...>           Send message to tab N
  maw contacts                List Oracle contacts
  maw contacts add <name>     Add/update contact (--maw, --thread, --notes)
  maw contacts rm <name>      Retire a contact (soft delete)
  maw mega                    Show MegaAgent team hierarchy tree
  maw mega status             Same — all teams with members + tasks
  maw mega stop               Kill all active team panes
  maw federation status       Peer connectivity + agent counts
  maw federation sync         Pull live /api/identity → auto-update config.agents
  maw federation sync --dry-run   Preview diff, no writes
  maw federation sync --check     Exit 1 if out-of-sync (CI)
  maw federation sync --prune     Also remove oracles no longer hosted anywhere
  maw federation sync --force     Overwrite existing routes on conflict
  maw talk-to <agent> <msg>    Thread + hey (persistent + real-time)
  maw <agent> <msg...>        Shorthand for hey
  maw <agent>                 Shorthand for peek
  maw assign <issue-url>      Clone repo + wake oracle with issue as prompt
  maw assign <issue-url> --oracle <name>  Explicit oracle
  maw costs                   Token usage + estimated cost per agent
  maw pr [window]             Create PR from current branch (links issue if branch has issue-N)
  maw triggers                List configured workflow triggers
  maw ping [node]             Check peer connectivity (all or specific)
  maw transport status        Transport layer connectivity (tmux/HTTP)
  maw avengers status         ARRA-01 rate limit monitor (all accounts)
  maw avengers best           Account with most capacity
  maw avengers traffic        Traffic stats across accounts
  maw workspace create <name> Create workspace on hub
  maw workspace join <code>   Join with invite code
  maw workspace share <a...>  Share agents to workspace
  maw workspace unshare <a..> Remove agents from workspace
  maw workspace ls            List joined workspaces
  maw workspace agents [id]   List all agents in workspace
  maw workspace invite [id]   Show join code
  maw workspace leave [id]    Leave workspace
  maw workspace status        Connection status to hub(s)
  maw ws ...                  Alias for workspace
  maw serve [port]            Start API server (default: 3456)

\x1b[33mWake modes:\x1b[0m
  maw wake neo                Wake main repo
  maw wake hermes bitkub      Wake existing worktree
  maw wake neo --new free     Create worktree + wake
  maw wake neo --issue 5      Fetch issue #5 + send as claude -p prompt
  maw wake neo --issue 5 --repo org/repo   Explicit repo
  maw wake neo --incubate org/repo         Clone via ghq + worktree
  maw wake neo --incubate org/repo --issue 5  Incubate + issue prompt

\x1b[33mPulse add:\x1b[0m
  maw pulse ls                Board table (terminal)
  maw pulse ls --sync         + update daily thread checkboxes
  maw pulse add "Fix bug" --oracle neo
  maw pulse add "task" --oracle neo --wt oracle-v2

\x1b[33mEnv:\x1b[0m
  MAW_HOST=white.local        SSH target (default: white.local)

\x1b[33mExamples:\x1b[0m
  maw wake neo --new bitkub   Create worktree + start claude
  maw pulse add "Fix IME" --oracle neo --priority P1
  maw hey neo what is your status
  maw serve 8080`);
}
