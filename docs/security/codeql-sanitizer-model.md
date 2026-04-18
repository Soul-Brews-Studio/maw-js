# CodeQL sanitizer model for `sanitizeLogField`

Closes the log-injection bucket of #474 by telling CodeQL that the 4
call sites in `src/transports/hub-connection.ts` are protected by
`sanitizeLogField` (src/core/util/sanitize-log.ts) — a real sanitizer.

## Problem

CodeQL's `security-extended` pack flags 4 sites in
`src/transports/hub-connection.ts`:

| Line | Untrusted source                           |
|------|--------------------------------------------|
| 57   | `msg.workspaceId` (WS frame, `auth-ok`)     |
| 87/88 | `msg.nodeId` (WS frame, `node-joined`)     |
| 92/93 | `msg.nodeId` (WS frame, `node-left`)       |
| 103/104 | `msg.message` / `msg.reason` (WS frame, `error`) |

(Line numbers shift slightly with the `// lgtm[...]` comments this PR
adds — see the actual code for the canonical positions.)

All sites are already wrapped in `sanitizeLogField(...)`. CodeQL's
default taint model doesn't recognize the helper, so it reports false
positives every run.

Header from `src/core/util/sanitize-log.ts`:

> Sanitize an attacker-influenceable string before logging.
> Closes CodeQL `js/log-injection` (alpha.129 first-scan, issue #474).
> This helper neutralizes [newline / ANSI / control] … Use
> `sanitizeLogField` for any value that originated outside this process
> AND is about to be interpolated into a log line.

The helper strips ANSI CSI/OSC, all ASCII control bytes except tab, and
truncates with a visible marker. It is a sanitizer by construction.

## Options considered

1. **OPTION A — CodeQL model pack (tried, reverted).** A local
   `.github/codeql/models/sanitize-log.model.yml` declaring
   `sanitizeLogField` as a `sanitizerModel` addition to
   `codeql/javascript-all`, referenced from `codeql-config.yml` via
   `packs:`. First attempt in this PR. **Failed in CI**: the CodeQL
   action's `packs:` config entries must be *published* pack specs
   (`<scope>/<name>[@<version>]`). The hosted analyzer has no resolver
   for an unpublished local path. Publishing a model pack to the CodeQL
   registry is out of scope for this fix — it would require a separate
   pipeline, versioning decisions, and trust setup.
2. **OPTION B — Inline suppression (shipped; empirically does not
   close).** Add `// lgtm[js/log-injection]` comments on the 4 lines,
   each citing the sanitizer + tracking issues. **Correction
   (2026-04-19):** the original claim that "GitHub CodeQL still
   honors the legacy LGTM annotation format for backwards
   compatibility" is empirically false. The `// lgtm[query-id]`
   convention belonged to LGTM.com (sunset 2022-12-16); the
   GitHub-hosted CodeQL analyzer does not parse it. All 4
   log-injection alerts remain open as of the 2026-04-19 Code
   Scanning API check. See
   `docs/security/lgtm-annotation-investigation.md`. Comments are
   retained in source as human-readable rationale, not as
   suppressions. Closing the alerts requires either the Code
   Scanning dismissal API or OPTION A (a published sanitizer model
   pack).
3. **OPTION C — `query-filters` exclude (rejected).** Would suppress
   *every* `js/log-injection` finding in the repo, including real
   future ones.

We ship **OPTION B**. It is per-call-site noise, but it is the only
option that is (a) self-contained to the repo and (b) doesn't need a
publishing pipeline for a single-helper model pack.

## Future: revisit OPTION A

If we ever add a second sanitizer, the per-line comment cost crosses
the threshold where publishing a model pack becomes worthwhile. At that
point:

- Publish `maw-js/sanitizer-models` to the GitHub CodeQL registry (or
  the equivalent per our org policy).
- Re-introduce `.github/codeql/codeql-config.yml` with
  `packs: maw-js/sanitizer-models@<version>`.
- Wire the workflow with `config-file: ./.github/codeql/codeql-config.yml`.
- Remove the `// lgtm[...]` comments.

## Test strategy

CodeQL can't be run locally without a paid Semmle setup. Instead:

- `bun run test:all` must stay green — the change is a comment plus a
  reverted workflow edit; no code paths touched.
- After merge, the next scheduled scan (Monday 06:37 UTC) re-runs
  CodeQL on `main`. Expected-closed alerts were:
  - `js/log-injection` on the `auth-ok` log line (workspaceId)
  - `js/log-injection` on the `node-joined` log line (nodeId)
  - `js/log-injection` on the `node-left` log line (nodeId)
  - `js/log-injection` on the `error` log line (message/reason)
- **Outcome (2026-04-19):** all 4 alerts remained open after the
  post-#586 scan. Per
  `docs/security/lgtm-annotation-investigation.md`, the hosted
  analyzer does not honor `// lgtm[query-id]`. Follow-up is either
  the Code Scanning dismissal API (per-alert, cheap) or OPTION A via
  a published pack (structural, bundles well if a second sanitizer
  arrives).

## Related

- #474 — CodeQL first-scan bucket that introduced `sanitizeLogField`.
- #486 — tracking issue for CodeQL alert cleanup.
