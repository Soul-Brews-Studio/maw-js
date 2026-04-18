# CodeQL sanitizer model for `sanitizeLogField`

Closes the log-injection bucket of #474 by teaching CodeQL that
`sanitizeLogField` (src/core/util/sanitize-log.ts) is a real sanitizer
for the `js/log-injection` query.

## Problem

CodeQL's `security-extended` pack flags 4 sites in
`src/transports/hub-connection.ts`:

| Line | Untrusted source           |
|------|----------------------------|
| 57   | `msg.workspaceId` (WS frame) |
| 87   | `msg.nodeId` (WS frame)      |
| 91   | `msg.nodeId` (WS frame)      |
| 101  | `msg.message` / `msg.reason` (WS frame) |

All 4 are already wrapped in `sanitizeLogField(...)`. CodeQL's default
taint model doesn't recognize the helper, so it reports false positives
every run. See header of `src/core/util/sanitize-log.ts`:

> Sanitize an attacker-influenceable string before logging.
> Closes CodeQL `js/log-injection` (alpha.129 first-scan, issue #474).
> This helper neutralizes [newline/ANSI/control] … Use `sanitizeLogField`
> for any value that originated outside this process AND is about to be
> interpolated into a log line.

The helper strips ANSI CSI/OSC, all ASCII control bytes except tab, and
truncates with a visible marker. It is a sanitizer by construction.

## Why a model — not inline suppression

Three options were considered:

1. **OPTION A — CodeQL model pack.** YAML extension declaring the
   function as a `sanitizerModel` addition to `codeql/javascript-all`.
   Config referenced from `.github/workflows/codeql.yml` via
   `config-file:`. This is the idiomatic fix: teach the analyzer once,
   every future call site is covered for free, no per-line pollution.
2. **OPTION B — Inline suppression.** `// lgtm[js/log-injection]`
   comments on the 4 lines. Modern CodeQL retains partial compatibility
   with the legacy LGTM.com comment syntax, but it is not a first-class
   feature and has been unreliable across action versions. Also does not
   scale — every new call site needs a new comment.
3. **OPTION C — `query-filters` to drop the query.** Rejected:
   would also drop *real* log-injection findings elsewhere.

We ship **OPTION A**. The analysis agent evaluated feasibility:
`sanitizerModel` is the documented extensible predicate for JS taint
tracking (github/codeql `javascript-all` pack), and `js/log-injection`
participates in the shared taint configuration that honors it. The
downside is that model-pack semantics for JS sanitizers have shifted
between CodeQL releases, so if the next `alpha` scan still reports the
4 alerts, we revert to OPTION B in a follow-up PR rather than churning
this one.

## File layout

```
.github/codeql/
  codeql-config.yml        # referenced by the workflow
  models/
    sanitize-log.yml       # the sanitizer declaration
```

`codeql-config.yml` uses `packs:` to include the local model pack and
preserves the existing `security-extended` query suite.
`sanitize-log.yml` declares one row in `sanitizerModel` targeting the
`log-injection` flow label for argument 0 of `sanitizeLogField`.

`.github/workflows/codeql.yml` gains a single line:
`config-file: .github/codeql/codeql-config.yml`.

## Test strategy

CodeQL can't be run locally without a paid Semmle setup. Instead:

- `bun run test:all` must stay green — the model is YAML-only, no code
  paths touched. A regression here would indicate we broke something
  unrelated while editing.
- After merge, the next scheduled scan (Monday 06:37 UTC) will re-run
  CodeQL on `main`. Expected-closed alerts:
  - `js/log-injection` at `src/transports/hub-connection.ts:57`
  - `js/log-injection` at `src/transports/hub-connection.ts:87`
  - `js/log-injection` at `src/transports/hub-connection.ts:91`
  - `js/log-injection` at `src/transports/hub-connection.ts:101`
- If any of the 4 remain after the next scan, open a follow-up that
  swaps OPTION A for OPTION B (inline `// lgtm[js/log-injection]` on
  each of the 4 lines, citing #474 + #486).

## Related

- #474 — CodeQL first-scan bucket that introduced `sanitizeLogField`.
- #486 — tracking issue for CodeQL alert cleanup.
