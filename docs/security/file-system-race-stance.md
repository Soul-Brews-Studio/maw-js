---
title: File-system-race stance
status: adopted
related: [#474, #581, #592]
last_verified: 2026-04-19
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
| **PRIVATE-PATH**  | Accept    | Path lives entirely under the user's own `~/.maw/` or the user-owned scaffold destination. Racing requires same-uid shell, which is out of our threat model. |
| **POST-FIX-STALE**| Accept with ref | Site was already converted to fd-based I/O in a prior fix; CodeQL's next scan hasn't cleared the alert yet. Cite the fix PR. |

New alerts that do not fit any of the three classes are not covered by
this stance and must be triaged on their own merits (typically: fix).

"Accept" means: the alert stays surfaced by CodeQL until it is
explicitly dismissed via the Code Scanning API (see *Acceptance
mechanism* below). An inline comment alone does not close the alert.

## The 10+1 accepted sites from #592

All 10 PRIVATE-PATH sites write JSON metadata, scaffold boilerplate,
or inbox files under a path rooted in `~/.maw/` or a user-owned
scaffold destination. None guards a privilege boundary. As of
2026-04-19 the alerts are still open because #592 relied on an
inline `// lgtm[...]` comment; see *Acceptance mechanism* — the
follow-up dismissal sweep is tracked off #474.

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

## Acceptance mechanism

For the accepted classes (PRIVATE-PATH, POST-FIX-STALE), the alert is
closed by **dismissing it via the Code Scanning API** with a
justification pointer back to this document. The inline comment that
sits next to the accepted site is human documentation, not a
suppression signal.

```
PATCH /repos/Soul-Brews-Studio/maw-js/code-scanning/alerts/{number}
{
  "state": "dismissed",
  "dismissed_reason": "won't fix",          // PRIVATE-PATH
  "dismissed_comment": "PRIVATE-PATH under ~/.maw/<...>; out of threat model per docs/security/file-system-race-stance.md"
}
```

or `"dismissed_reason": "false positive"` for POST-FIX-STALE, citing
the fix PR.

### Why not inline `// lgtm[js/file-system-race]`

See `docs/security/lgtm-annotation-investigation.md` for the full
audit. Short version: the GitHub-hosted CodeQL analyzer does not
parse `// lgtm[query-id]` comments as suppressions. That convention
belonged to LGTM.com (sunset 2022-12-16). All 10 such comments
shipped in #592 left their alerts open on the next scan.

The inline comments placed in #592 are kept in source as a
convenient breadcrumb from a flagged line to this stance doc. They
are not load-bearing for alert closure.

### Why not broader `paths-ignore`

`paths-ignore` is the correct tool only when dropping *every* query
on a file is acceptable. It is already applied to four
tightly-scoped, pre-reviewed files where the lost query coverage is
genuinely low-value (lock primitives + the from-repo scaffold
writer). Extending it to the rest of the PRIVATE-PATH list would
shed coverage on large files where other security queries still
carry signal — e.g. `team-lifecycle.ts` is 250+ LOC of team
orchestration, not a 40-LOC primitive.

## Policy

Before merging any PR that lands a new `js/file-system-race` finding:

1. Each new finding is classified per the rubric above.
2. TRUE-TOCTOU findings get fixed (fd-based open + read/write under
   the opened descriptor, like #581) — never accepted.
3. PRIVATE-PATH and POST-FIX-STALE findings are accepted by
   dismissing the alert via the Code Scanning API with a
   `dismissed_comment` pointing at this doc (and, for
   POST-FIX-STALE, the fix PR).
4. An inline `// lgtm[js/file-system-race]` or plain `// CodeQL:
   accepted per docs/security/file-system-race-stance.md` comment
   may be added next to the site as human documentation, but does
   not replace the dismissal step.
5. If the classification is genuinely ambiguous, default to fixing,
   or open a discussion issue rather than accepting.

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
- #592 — shipped the original 10 inline `// lgtm[...]` annotations
  (kept as breadcrumbs; no longer described as suppressions).
- `docs/security/codeql-sanitizer-model.md` — parallel stance for the
  `js/log-injection` bucket of #474.
- `docs/security/lgtm-annotation-investigation.md` — audit behind the
  acceptance-mechanism update in this doc.
