# Install recovery

> Full runbook lives in PR [#550](https://github.com/Soul-Brews-Studio/maw-js/pull/550) /
> `docs/install-recovery.md` on `main` once merged. This file on the `#551`
> branch carries only the root-cause-fix note below so the CHANGELOG entry
> has a link target.

## Root-cause fix landed (#551)

As of the next alpha release, `maw update` stashes your existing binary
to `~/.bun/bin/maw.prev` before running the fallback `bun remove -g`.
If the retry also fails, the previous binary is restored automatically.
You should no longer see "maw: command not found" after a failed update.

Concurrent `maw update` invocations are now serialized via
`~/.maw/update.lock` — the second one waits up to 60 seconds for the
first to finish, then takes over if no progress.

The `maw doctor` + `maw-heal.sh` tools from #550 remain useful when:
- You're on an older alpha that predates this fix
- Some other process (manual `bun remove`, disk issue, etc.) kills the binary
- The stash rename fails due to permissions or disk full
