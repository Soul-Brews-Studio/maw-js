# `.claude/` — project-scoped Claude Code config

Soft-warning hooks for the size discipline documented in [CONTRIBUTING.md](../CONTRIBUTING.md#pr-size).

## What's here

| File | Purpose |
|------|---------|
| `settings.json` | Registers PostToolUse + Stop hooks |
| `hooks/check-file-size.sh` | Warn when a touched file exceeds 200 LOC (per-file cap) — installed at incubation from mawui-oracle (2026-04-11) |
| `hooks/check-pr-size.sh` | Warn when current branch diff exceeds 300 LOC (PR cap) — added 2026-04-18 alongside the documented cap |
| `INCUBATED_BY` | Provenance breadcrumb (incubator + date) |

## How it works

Claude Code auto-loads `.claude/settings.json` when invoked in this repo and runs the registered hooks at the lifecycle points:

- **PostToolUse on Write/Edit**: each file write triggers a line-count check on the touched file; emits an `additionalContext` JSON line if > 200 LOC. The notification surfaces back to the agent's next turn.
- **Stop**: at the end of each AI turn, sums production-code additions vs `origin/main`; warns to stderr if > 300 LOC.

Both are **soft warnings — non-blocking** (exit 0 always). They surface drift early but never prevent shipping.

## Exemptions

Per CONTRIBUTING.md, the **per-file cap** is conceptually exempt for:
- Markdown, JSON, YAML, TOML, lockfiles, snapshots
- Anything under `test/`, `tests/`, `__tests__/`, `fixtures/`
- Anything under `dist/`, `build/`, `node_modules/`, `coverage/`
- Type-definition files (`*types.ts`, `*.d.ts`)

(The current `check-file-size.sh` is broader — flags any Write/Edit > 200 LOC without filtering. A future tightening pass can add the exemptions; until then the false-positive rate is the trade-off for simplicity.)

The **PR cap** in `check-pr-size.sh` already filters tests / fixtures / generated / docs.

## Disabling locally

Contributors who don't want these warnings can override in `~/.claude/settings.json` or `.claude/settings.local.json`. Hooks can also be toggled per-project in Claude Code settings.

## Adding more hooks

Drop a new `.sh` in `hooks/` and register it in `settings.json`. Keep each hook ≤ 150 LOC and non-blocking unless absolutely necessary — the [arra-safety-hooks](https://github.com/Soul-Brews-Studio/arra-safety-hooks) global repo handles destructive-op blocks.
