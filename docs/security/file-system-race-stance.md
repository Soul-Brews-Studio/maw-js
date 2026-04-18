---
title: File-system-race stance
status: adopted
related: [#474, #581]
---

# File-system-race stance

This document is the policy we apply when CodeQL's
`js/file-system-race` query fires on maw-js. It closes the
`js/file-system-race` bucket of #474 and is the rubric every future
flagged site must pass before merging.

## Threat model

`maw` is a local, single-user CLI. It runs as the invoking user's uid
and operates against that user's own state:

- `~/.maw/` — teams, inboxes, task artifacts, fleet cache, lockfiles
- project working directories the user owns (scaffold destinations
  like a freshly-budded oracle repo)

An attacker who can place a file inside `~/.maw/` at a racing moment
already has a local shell running as the same uid as the user. In that
posture, every file the user can read or write is already reachable
without racing the CLI — the TOCTOU is redundant with shell access.
This is distinct from a multi-tenant daemon guarding root-owned paths,
where a lower-privileged attacker can race a privileged check; that
threat model doesn't apply here.

This framing matches the POSIX convention that per-user state under
`$HOME` is trusted relative to other uids, untrusted relative to the
user themselves (for which we have no defense and no mandate).

## Classification rubric

Every `js/file-system-race` alert on a maw-js PR must be tagged with
exactly one of:

| Class             | Action    | When                                                                        |
|-------------------|-----------|-----------------------------------------------------------------------------|
| **TRUE-TOCTOU**   | Fix       | Shared/system path, or per-user path where racing changes a privilege/trust boundary (e.g. single-writer lockfile, pid ownership). Apply fd-based open/read/write like #581. |
| **PRIVATE-PATH**  | Suppress  | Path lives entirely under the user's own `~/.maw/` or the user-owned scaffold destination. Racing requires same-uid shell, which is out of our threat model. |
| **POST-FIX-STALE**| Suppress with ref | Site was already converted to fd-based I/O in a prior fix; CodeQL's next scan hasn't cleared the alert yet. Cite the fix PR. |

New alerts that do not fit any of the three classes are not covered by
this stance and must be triaged on their own merits (typically: fix).

## The 10+1 sites suppressed in this PR

All 10 PRIVATE-PATH sites write JSON metadata, scaffold boilerplate,
or inbox files under a path rooted in `~/.maw/` or a user-owned
scaffold destination. None guards a privilege boundary.

| Site                                              | Class          | Justification                                                              |
|---------------------------------------------------|----------------|----------------------------------------------------------------------------|
| `src/commands/plugins/bud/bud-init.ts:31`         | PRIVATE-PATH   | Writes `CLAUDE.md` stub into freshly-budded user-owned repo.               |
| `src/commands/plugins/team/task-ops.ts:34`        | PRIVATE-PATH   | Writes `counter.json` under `~/.maw/teams/<team>/`.                        |
| `src/commands/plugins/team/team-helpers.ts:77`    | PRIVATE-PATH   | Writes teammate shutdown-request inbox under `~/.maw/teams/<team>/inboxes/`. |
| `src/commands/plugins/team/team-helpers.ts:98`    | PRIVATE-PATH   | Writes teammate message inbox under `~/.maw/teams/<team>/inboxes/`.        |
| `src/commands/plugins/team/team-lifecycle.ts:221` | PRIVATE-PATH   | Writes team manifest under `~/.maw/teams/<team>/`.                         |
| `src/commands/plugins/team/team-lifecycle.ts:232` | PRIVATE-PATH   | Writes tool-store `config.json` under `~/.maw/teams/<team>/` (#393 bridge). |
| `src/commands/shared/plugin-create-as.ts:21`      | PRIVATE-PATH   | Rewrites `package.json` inside user-owned scaffold destination.            |
| `src/core/fleet/registry-oracle-cache.ts:55`      | PRIVATE-PATH   | Writes merged fleet registry cache under `~/.maw/`.                        |
| `src/lib/artifacts.ts:62`                         | PRIVATE-PATH   | Updates artifact `meta.json` under `~/.maw/artifacts/<team>/<task>/`.      |
| `src/plugin/registry-helpers.ts:92`               | PRIVATE-PATH   | Writes `legacy-plugin-warning` throttle state under user state dir.        |
| `src/cli/update-lock.ts:55`                       | POST-FIX-STALE | Fd-based read; site was converted in #581 — alert is pre-fix stale.        |

Not in this PR (handed to the TOCTOU fix, task #1): the three sites
that cross a trust boundary on a shared lockfile / pid file —
`src/core/peers/lock.ts:42`, `src/core/peers/lock.ts:47`,
`src/core/runtime/instance-pid.ts:56`.

## Policy

Before merging any PR that lands a new `js/file-system-race` finding:

1. Each new finding is classified per the rubric above.
2. PRIVATE-PATH and POST-FIX-STALE findings get a `// lgtm[js/file-system-race]`
   comment with a one-line rationale naming either this doc or the
   prior fix PR.
3. TRUE-TOCTOU findings get fixed (fd-based open + read/write under
   the opened descriptor, like #581) — never suppressed.
4. If the classification is genuinely ambiguous, default to fixing, or
   open a discussion issue rather than suppressing.

## Revisit triggers

Re-open this stance and re-audit the suppressed sites if any of:

- `maw` grows a privileged/daemon mode that runs as a different uid
  than the calling user.
- The `~/.maw/` directory gains a mode that is group- or
  world-writable, or we begin honoring `$MAW_STATE_DIR` pointing
  outside the user's home.
- A scaffold destination moves to a shared path (e.g. `/var/lib/maw`)
  — PRIVATE-PATH no longer holds there.

## Related

- #474 — CodeQL first-scan bucket.
- #581 — fd-based write for `update-lock` (informs POST-FIX-STALE).
- `docs/security/codeql-sanitizer-model.md` — parallel stance for the
  `js/log-injection` bucket of #474.
