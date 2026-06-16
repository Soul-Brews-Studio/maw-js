# Codex Team Pattern

This page is the orchestration reference for running a maw-js sprint with Codex/Claude agents. It defines the charter shape, engine resolution rules, inheritance behavior, and common `maw team up` commands.

## Charter format

```yaml
name: mawjs-sprint
project: Soul-Brews-Studio/maw-js
goal: Fix CI failures and ship to alpha

# Engine aliases -> full launch command
engines:
  opus: "claude --model opus --dangerously-skip-permissions"
  sonnet: "claude --model sonnet --dangerously-skip-permissions"
  omx: "omx --yolo --direct"
  omx-full: "codex --model gpt-5.5"

defaults:
  engine: opus
  worktree: true
  target: alpha

members:
  - name: mawjs-oracle
    role: lead
    engine: opus
    worktree: false
    cwd: /opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle
    prompt: |
      Lead orchestrator for team mawjs-sprint.
      You dispatch issues, review PRs, merge when green.
      You NEVER write code yourself — only dispatch via maw hey.
      Monitor with /codex-monitor. Feed context to low-ctx agents.

  - name: codex-1
    role: builder
    engine: omx-full
    worktree: true
    cwd: /opt/Code/github.com/Soul-Brews-Studio/maw-js/agents/1-codex-1
    branch: fix-2512-codemod
    prompt: |
      You are codex-1 on team mawjs-sprint.
      Task: Fix PR #2512 CI failure (test-isolated-2of4).
      Rebase on alpha, find failing test, fix it.
      PRs target alpha. Body must include "Closes #2495".
      When done: maw hey mawjs-oracle "done #2512 PR #NNNN"

  - name: codex-2
    role: builder
    engine: omx
    worktree: true
    cwd: /opt/Code/github.com/Soul-Brews-Studio/maw-js/agents/1-codex-2
    branch: fix-2518-ui-state
    prompt: |
      You are codex-2 on team mawjs-sprint.
      Task: Suppress /api/ui-state log spam (#2518).
      maw-ui polls every ~100ms — batch logs to 10s intervals.
      PRs target alpha. Body must include "Closes #2518".
      When done: maw hey mawjs-oracle "done #2518 PR #NNNN"

  - name: codex-3
    role: builder
    engine: opus
    worktree: true
    cwd: /opt/Code/github.com/Soul-Brews-Studio/maw-js/agents/1-codex-3
    branch: fix-2519-config-engines
    prompt: |
      You are codex-3 on team mawjs-sprint.
      Task: Activate config.engines as primary (#2519).
      Route all command rendering through resolveEngine().
      Deprecate config.commands (keep as shim).
      PRs target alpha. Body must include "Closes #2519".
      When done: maw hey mawjs-oracle "done #2519 PR #NNNN"
```

`cwd` paths may use the local GHQ root. On m5 this is `/opt/Code`; on other machines it may be `/home/oss/Code`, `/Users/nat/Code`, or another root. At runtime, `maw team up` should resolve the `project:` slug via `ghqFind()` and derive the member `cwd` if the literal path does not exist locally.

## Engine resolution

`engine` is an alias name that resolves to one full launch command string. There is no separate `model` field in the charter.

Resolution order:

```text
member.engine ("omx-full")
  -> charter.engines["omx-full"]    = "codex --model gpt-5.5"
  -> config.engines["omx-full"].cmd  (fallback if not in charter)
  -> config.commands["omx-full"]     (legacy fallback)
  -> "omx-full" as raw command       (last resort)
```

Prefer `engines:` in the charter for sprint-local choices. Use `config.engines` for machine/user defaults. Keep `config.commands` as compatibility only.

## Defaults and inheritance

Members inherit from the top-level `defaults:` block. A member's explicit field wins over the inherited default.

Examples from the charter above:

```text
codex-1: engine=omx-full (overrode), worktree=true (inherited), target=alpha (inherited)
codex-3: engine=opus (inherited), worktree=true (inherited), target=alpha (inherited)
oracle:  engine=opus (inherited), worktree=false (overrode), target=alpha (inherited)
```

Use `defaults:` to keep sprint-wide constraints visible: target branch, worktree isolation policy, and preferred engine.

## CLI workflow

```bash
maw team up mawjs-sprint                    # spawn all members from charter
maw team up mawjs-sprint --only codex-1     # spawn one member
maw team up mawjs-sprint --engine sonnet    # override engine for all members
maw team up mawjs-sprint --dry-run          # preview resolved config
```

Recommended loop for the lead:

1. Load the charter and run `maw team up <name> --dry-run`.
2. Spawn only the lead first if the run needs manual triage.
3. Spawn builders with `--only` when assigning independent issues.
4. Monitor with `maw peek`, `maw activity`, CI, and PR status.
5. Feed context to low-context agents instead of interrupting active work.
6. Merge only when tests and required checks are green.

## References

- `docs/teams.md` — broader maw team and coordination reference.
- `docs/comparison/team-agents-vs-maw-team.md` — choosing between session teams and persistent maw teams.
- #2519 — activate `config.engines` as primary.
- #1960 — RFC: Lean maw / EngineDef schema.
- #2524 — add `buddy` alias for `bud`.
