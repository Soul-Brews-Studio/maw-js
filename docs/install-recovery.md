# Install Recovery Runbook

> What to do when `maw: command not found` appears out of nowhere.
> Tracking issue: [#531](https://github.com/Soul-Brews-Studio/maw-js/issues/531).

## Overview

Some users have seen `maw` disappear from `$PATH` without running any
uninstall command. The root cause is still under investigation:

- Initial theory (manifest non-persistence after `bun add -g` from a GitHub
  source) was **disproven** on 2026-04-18: `~/.bun/install/global/package.json`
  **does** contain a `"maw"` entry after a fresh install.
- The real sweep mechanism is unknown. Candidates: concurrent `bun add -g`
  calls, bun cache eviction, interaction with `bun update`, or a user-side
  shell tool that prunes dangling symlinks.

Until the root cause is identified, we ship three recovery paths and a
runbook for what to report if it recurs.

## Symptom checklist

You are looking at the #531 sweep if:

- [ ] `maw` worked yesterday, today `command -v maw` is empty.
- [ ] `~/.bun/bin/maw` is missing or a dangling symlink.
- [ ] `~/.bun/install/global/node_modules/maw` may or may not still be present.
- [ ] You did not run `bun remove -g maw`, `maw uninstall`, or edit `$PATH`.

If any of those do not match, check your shell rc files first — this may
not be the #531 sweep.

## Recovery path 1 — one-shot reinstall

Fastest. No tooling needed:

```bash
bun add -g github:Soul-Brews-Studio/maw-js
command -v maw   # expect: ~/.bun/bin/maw
maw --version
```

Re-open your shell if the new binary is not on `$PATH`.

## Recovery path 2 — `maw doctor`

`maw doctor` runs an in-process integrity check. Because it can be invoked
via `bunx` directly from the GitHub source, it works even when the symlink
is already gone:

```bash
bunx -p github:Soul-Brews-Studio/maw-js maw doctor
```

What it does:

1. Resolves whether `~/.bun/bin/maw` exists and points at a real file.
2. Verifies `~/.bun/install/global/node_modules/maw` is installed and
   matches the manifest.
3. If either check fails, re-runs `bun add -g github:Soul-Brews-Studio/maw-js`
   and re-verifies.
4. Exits non-zero with a structured report if recovery fails.

Run `maw doctor` any time you suspect the install is drifting — it is
safe to run on a healthy system (no-op).

## Recovery path 3 — shell hook

For users who have hit the sweep more than once, source the heal script
from your shell rc so every new shell checks itself:

```bash
# In ~/.bashrc or ~/.zshrc
. "$HOME/.ghq/github.com/Soul-Brews-Studio/maw-js/scripts/maw-heal.sh"
```

The hook is silent in the happy path. If `maw` is missing, it prints a
single line and reinstalls in the background.

## Prevention

Installation patterns that appear to reduce sweep frequency:

- Prefer `curl -fsSL …/install.sh | bash` over ad-hoc `bun add -g`. The
  installer is idempotent and records provenance.
- Avoid running two `bun add -g …` commands concurrently in different
  shells.
- Keep bun on a recent release; older bun versions had separate global
  manifest bugs that are now fixed.

## When it recurs — what to report

If you hit the sweep again, comment on [#531](https://github.com/Soul-Brews-Studio/maw-js/issues/531)
with:

- Timestamp (with timezone) when `maw` was last known working.
- Timestamp when you first noticed it was gone.
- Output of `bun --version` and `uname -a`.
- The last 20 commands you ran (`history | tail -20`) — especially any
  `bun`, `npm`, `pnpm`, or `brew` calls.
- Contents of `~/.bun/install/global/package.json`.
- Whether `~/.bun/install/global/node_modules/maw` still exists.

That dataset is what the investigator agent on team `persist-531` needs
to narrow the sweep mechanism.

## Status

- **Mitigations shipped**: paths 1-3 above.
- **Root cause**: unknown, under investigation.
- **Issue state**: #531 remains **open** until the sweep mechanism is
  identified and a real fix lands (likely an `@maw`-scoped npm publish
  or a bun-persistence-preserving install command).
