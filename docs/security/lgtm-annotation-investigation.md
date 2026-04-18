---
title: Inline `// lgtm[rule]` annotations don't close CodeQL alerts (investigation)
status: closed
related: [#474, #486, #586, #590, #592]
verified_on: 2026-04-19
---

# Why inline `// lgtm[rule]` annotations don't close CodeQL alerts on maw-js

This is the investigation log behind the policy shift in
`docs/security/file-system-race-stance.md` and the correction to
`docs/security/codeql-sanitizer-model.md`. It records what we shipped,
what we expected, what actually happened, and why.

## TL;DR

`// lgtm[query-id]` was an **LGTM.com** comment convention, not a
CodeQL-native suppression mechanism. The GitHub-hosted CodeQL analyzer
that powers `github/codeql-action/analyze` does not parse those
comments as alert suppressions. Every site we annotated in #586
(log-injection × 4) and #592 (file-system-race × 10) still shows
`state: "open"` on the code-scanning API, with `dismissed_reason:
null` and an empty `classifications` array.

The comments do no harm — they are still useful as inline rationale
for human reviewers — but they should not be described as a
suppression mechanism.

## What we expected

Per the claim committed into `docs/security/codeql-sanitizer-model.md`
§OPTION B (PR #586):

> GitHub CodeQL still honors the legacy LGTM annotation format for
> backwards compatibility, which routes through SARIF as a fingerprint
> suppression.

And per the classification rubric in
`docs/security/file-system-race-stance.md` (PR #592):

> PRIVATE-PATH and POST-FIX-STALE findings get a
> `// lgtm[js/file-system-race]` comment with a one-line rationale …

Implication: after the next scheduled CodeQL scan on `main`, the 14
annotated alerts should transition to `closed`/`dismissed`.

## What actually happened

Verified 2026-04-19 against
`GET /repos/Soul-Brews-Studio/maw-js/code-scanning/alerts?state=open`:

| Rule | Count open | Alert numbers | PR that added `// lgtm` |
|------|-----------:|---------------|-------------------------|
| `js/log-injection` | 4 | #74, #75, #76, #77 | #586 |
| `js/file-system-race` | 10 | #65–#68, #70–#73, #85, #86 | #592 |

Every one of the 14 alerts:
- `state`: `open`
- `dismissed_by`: `null`
- `dismissed_reason`: `null`
- `most_recent_instance.classifications`: `[]`

Annotation placement is correct — `grep -n 'lgtm\['` shows each
comment on the line immediately above the flagged source line, which
matches the LGTM.com convention. Placement is not the bug.

## Root cause

`// lgtm[<query-id>]` is documented at lgtm.com/help as an
LGTM.com-specific in-source suppression. LGTM.com was sunset by GitHub
on 2022-12-16. The GitHub-hosted CodeQL analyzer that replaced it
does not implement an in-source suppression comment of any form:

- The CodeQL CLI reads `codeql-config.yml` (`paths`, `paths-ignore`,
  `queries`, `query-filters`, `packs`) — no comment-based suppression.
- The CodeQL Action uploads SARIF to Code Scanning, which only honors
  dismissals recorded via the Code Scanning API or UI (`Dismiss
  alert`) and path-based exclusions expressed in config.
- `classifications: []` on every annotated alert confirms the
  analyzer did not recognize the comments as a suppression signal.

The trailing note already sitting in `.github/codeql/codeql-config.yml`
on `from-repo-exec.ts` captured the same observation empirically:

> Inline `// lgtm` markers are retained as context but do not
> suppress new alerts under the current GHAS CodeQL scanner.

This investigation generalizes that observation to all 14 sites.

## Why the #586 fix looked plausible at the time

Three signals made the LGTM-honors hypothesis reasonable:
1. CodeQL's documentation references the LGTM query-id namespace
   (`js/log-injection`, `js/file-system-race`) — the IDs are
   identical, so the comment *looks* like it should be parsed.
2. Some third-party integrations and older CodeQL CLI versions
   (pre-sunset) did strip `// lgtm[...]` at the SARIF fingerprint
   layer. Documentation search still surfaces those pages.
3. We had no way to run CodeQL locally (no Semmle licence), so
   verification was deferred to "the next scheduled scan" — which
   arrived, stayed red, and the signal was lost in the #474 triage
   backlog until this pass.

## Options going forward (ranked)

1. **Dismiss via Code Scanning API, per-alert, with justification.**
   `PATCH /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}`
   with `state: dismissed`, `dismissed_reason: "won't fix"` (or
   `"false positive"`), `dismissed_comment: <ref to stance doc>`.
   Preserves query coverage on the file, records rationale on the
   alert itself. Downside: manual or scripted; dismissal does not
   follow if the file is renamed, and a re-introduced alert on a
   nearby line re-opens.

2. **Publish a sanitizer model pack** (revisit OPTION A from
   `codeql-sanitizer-model.md`). Addresses the log-injection bucket
   permanently by teaching CodeQL about `sanitizeLogField`. Does not
   help the file-system-race bucket, which needs a path-level or
   policy-level accept, not a sanitizer.

3. **`paths-ignore` for entire files** in `codeql-config.yml`.
   Nuclear — drops every query on the file, not just the accepted
   rule. Already applied narrowly to `update-lock.ts`,
   `instance-pid.ts`, `peers/lock.ts`, `from-repo-exec.ts`. Extending
   to the remaining 7 PRIVATE-PATH files would lose coverage we do
   still want (e.g. `team-lifecycle.ts` is a large file where other
   security queries remain valuable).

4. **SARIF post-filter step** in the workflow (e.g.
   `advanced-security/filter-sarif`) between `analyze` and upload.
   Per-rule per-path precision, but adds a third-party dependency in
   the security pipeline — fragile and widens the trust surface.

5. **Accept the noise.** Alerts stay open; reviewers rely on the
   stance doc to tell signal from accepted noise. Works today, but
   erodes the useful property that an unacked alert means "look at
   me". The 14 PRIVATE-PATH/POST-FIX-STALE alerts are a sizeable
   fraction of the open list already.

## Recommendation

Combine (1) and (3):

- Keep `paths-ignore` for the four narrow files it already covers
  (lock primitives + `from-repo-exec.ts`) — coverage loss is
  acceptable and they are pre-reviewed.
- Dismiss the remaining 10 alerts (4 log-injection + 6
  file-system-race PRIVATE-PATH sites not under `paths-ignore`) via
  the Code Scanning API, one-shot script, with `dismissed_comment`
  citing `docs/security/file-system-race-stance.md` or
  `docs/security/codeql-sanitizer-model.md`.
- Keep the existing `// lgtm[...]` comments in source as
  human-readable rationale. Do not describe them as a suppression
  mechanism in any doc going forward.
- Revisit the sanitizer model pack (OPTION A) only when a second
  sanitizer is introduced — same threshold as the original analysis.

Dismissal-API tooling is out of scope for this investigation PR; this
document is the input to that follow-up ticket.

## Related

- #474 — CodeQL first-scan bucket (parent).
- #486 — log-injection triage (led to #586 inline lgtm, observed
  non-closing).
- #586 — shipped inline `// lgtm[js/log-injection]` × 4 expecting
  closure.
- #590 — fd-bound lock primitives; first empirical hint that inline
  lgtm does not close `js/file-system-race`.
- #592 — shipped inline `// lgtm[js/file-system-race]` × 10
  expecting closure.
- `docs/security/file-system-race-stance.md` — updated in this PR to
  reflect the empirical reality.
- `docs/security/codeql-sanitizer-model.md` — updated in this PR to
  retract the "LGTM comments still honored" claim.
