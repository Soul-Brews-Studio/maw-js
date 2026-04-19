# `MAW_PLUGIN_PEER_SEARCH` — rollout criteria (flip-gate plan)

Status: SPEC — when the env-opt-in flag flips to default-on.
Tracking issue: [#635](https://github.com/Soul-Brews-Studio/maw-js/issues/635)
Parent RFC: [marketplace-rfc.md](./marketplace-rfc.md) (Shape A — federated search)
Date: 2026-04-19

## Purpose

`MAW_PLUGIN_PEER_SEARCH` is the feature flag that gates
[Shape A](./marketplace-rfc.md#shape-a--federated-search) — federated
plugin discovery across peers via `maw plugin search --peers` and
`maw plugin install <name>@<peer>`.

This doc pins the criteria that must be met before the flag flips from
**default-off, opt-in** to **default-on, opt-out**. It is deliberately
*not* a dated plan — no "flip on 2026-05-15". The flip happens when the
criteria are green, not before.

## Current state (2026-04-19)

- Flag: `MAW_PLUGIN_PEER_SEARCH` (env var, truthy = enabled).
- Default: **off**. `maw plugin search --peers` only fans out to peers
  when the flag is set; otherwise the registry-only path runs.
- Phase: **opt-in alpha**. Exists so early adopters can exercise the
  federation path (dogfood matrix in
  [`dogfood-protocol.md`](./dogfood-protocol.md)) without imposing
  peer-fanout latency on users who never asked for it.
- Trust model: `plugins.lock` sha256 pinning is the trust root; the
  flag controls *discovery*, not trust. Flipping it on does not weaken
  install-time verification.

## Criteria to flip to default-on

All of the following must be green **simultaneously**. If any one
regresses after the flip, the rollback plan below applies.

### 1. Fedtest matrix 100% green across 12+ scenarios

The dogfood matrix in [`dogfood-protocol.md`](./dogfood-protocol.md)
covers tests 1–6 on a two-oracle pair. For the flip gate we require an
expanded matrix:

- All 6 tests PASS on ≥ 2 different peer pairs.
- Cross-node (not just localhost) run covered at least once.
- Both directions (A→B and B→A) covered.
- `--peers-only`, `--peers`, and `--peer <name>` each exercised.
- Offline-peer case covered (peer down mid-run, caller degrades cleanly).

That yields 12+ scenario cells; all must be PASS or SKIP-with-reason.
A single FAIL blocks the flip.

### 2. 2+ real cross-oracle installs succeeded (dogfood evidence)

Beyond synthetic tests, we need *lived* evidence:

- At least two independent oracles have run `maw plugin install
  <name>@<peer>` against a peer they did not author, and the plugin
  loaded + ran.
- Each install must produce a report under `ψ/reports/dogfood-*.md`
  (template in [`dogfood-protocol.md`](./dogfood-protocol.md#how-to-report-findings)).
- The two runs must be on different host OSes *or* different network
  topologies (localhost + cross-node, or two distinct LANs) — one
  environment isn't enough signal.

### 3. Adversarial harness ([#633](https://github.com/Soul-Brews-Studio/maw-js/issues/633)) has no open FAIL-BLOCKER

The `#633` adversarial suite exercises malicious-peer scenarios:
tarball corruption, sha256 mismatch, manifest schema abuse, slow-loris
timeouts, oversized responses, cert mismatch on https peers, etc.
Before the flip:

- Suite runs in CI on every push to `main`.
- Zero open failures tagged `FAIL-BLOCKER`.
- Known non-blocker findings are tracked as issues and linked from
  the suite's README.

A regression in this suite after the flip is a rollback trigger (see
below).

### 4. `/info` contract stable (no schema churn for 2 weeks)

`maw plugin search --peers` depends on the `/info` handshake
(capabilities advertisement) and `/api/plugin/list-manifest`. Their
response shapes must be stable:

- No schema-breaking change merged to `/info` for ≥ 14 days before
  the flip.
- `/api/plugin/list-manifest` response schema versioned and unchanged
  for ≥ 14 days.
- If a change is *planned*, the flip waits until 14 days past the
  landing date of that change.

The 14-day window is what lets peers on older alphas still participate
without being silently wire-incompatible.

### 5. Zero open security alerts on the peer surface

"Peer surface" = the code paths that accept bytes from a peer:
`searchPeers`, the manifest fetch, `@peer` install resolution, tarball
download + extract. Before the flip:

- Zero open CodeQL / Dependabot / audit alerts scoped to those files.
- Zero open issues labelled `security` touching those files.
- Most-recent `security-review` skill run on this surface returned
  clean (referenced from the release PR).

### 6. Documentation complete

The following docs must be shipped and accurate:

- [`shape-a-demo.md`](./shape-a-demo.md) — 7-step walkthrough ✓
  (landed).
- [`dogfood-protocol.md`](./dogfood-protocol.md) — repeatable
  matrix ✓ (landed).
- [`marketplace-rfc.md`](./marketplace-rfc.md) — Shape A design ✓
  (landed).
- This doc — rollout criteria ✓ (landed with #635).
- Changelog entry for the release that flips the default, describing
  opt-out path (`MAW_PLUGIN_PEER_SEARCH=0`).

## Phased rollout

1. **Alpha — opt-in** (current). `MAW_PLUGIN_PEER_SEARCH=1` required.
   `--peers` flag prints an `experimental` banner when used.
2. **Beta — opt-in, prominent** (transitional). Flag still required,
   but changelog + README + ecosystem post highlight it. Target: the
   release *after* criteria 1–3 go green, to gather dogfood reports
   toward criterion 2.
3. **GA — default-on, opt-out**. All criteria green + 30 days in Beta
   with no P0 reports from flag users. `MAW_PLUGIN_PEER_SEARCH=0`
   disables fanout for users who prefer registry-only.

No dated commitment on when each phase starts — advancement is
criteria-driven. Timing: **TBD, criteria-gated.**

## Rollback plan

If the flip causes regressions, the rollback sequence is cheap because
the code path already supports both modes.

### Rollback triggers (any one)

- P0 user report: install from a peer installed the wrong artifact,
  skipped sha256 verification, or corrupted `plugins.lock`.
- Nightly CI: the `#633` adversarial suite regresses (any
  FAIL-BLOCKER).
- Dogfood: a peer pair that previously passed the matrix now fails
  without an unrelated cause.
- Latency: `maw plugin search` median p95 crosses 3× the
  registry-only baseline in telemetry from ≥ 2 oracles.
- `/info` schema breakage reaches `main` and a peer stops being
  wire-compatible.

### Rollback steps

1. Ship a patch release that sets the default back to **off** —
   single-line change in the flag-check site. Default-off means users
   who didn't opt in stop fanning out immediately on upgrade.
2. Changelog entry naming the trigger and linking the issue.
3. Leave `MAW_PLUGIN_PEER_SEARCH=1` working for users who want to
   keep the behaviour; don't rip the code out.
4. File a tracking issue for the regression with a reproducer from the
   dogfood matrix.
5. Re-enter Beta when the trigger is resolved. Do not re-flip to GA
   until criteria 1–5 are re-validated.

Because the flag already gates the behaviour, **rollback is a default
change, not a code revert**. The Shape A code stays in-tree; only its
default activation moves.

## Non-goals

- A schedule. Criteria gate the flip; calendar time does not.
- Removing the opt-out. Even at GA, `MAW_PLUGIN_PEER_SEARCH=0` stays
  supported for users who want registry-only discovery.
- Weakening `plugins.lock`. sha256 pinning is the trust root under
  both default-off and default-on.
- Central-registry work (Shape B). See
  [`marketplace-rfc.md`](./marketplace-rfc.md#shape-b--central-registry)
  — a separate decision, not on this rollout's critical path.

## Open questions

1. Does telemetry for criterion 4 ("latency < 3× baseline") need a
   new opt-in metric, or can we derive it from existing peer-probe
   timings? (Preference: reuse existing timings; avoid a new metric.)
2. Should the Beta phase require an *explicit* changelog call-out in
   every intermediate release, or only in the Beta-entry release?
   (Preference: Beta-entry release only; avoid doc fatigue.)
3. For criterion 2 ("2+ real installs"), does a single human running
   two installs count, or must they be two *independent* operators?
   (Preference: two independent operators — the point is evidence of
   uptake, not a repeated run.)

Resolve before advancing to Beta.

## See also

- [marketplace-rfc.md](./marketplace-rfc.md) — Shape A vs Shape B.
- [shape-a-demo.md](./shape-a-demo.md) — 7-step demo script.
- [dogfood-protocol.md](./dogfood-protocol.md) — test matrix + report
  template.
- [search-peers-impl.md](./search-peers-impl.md) — #631 implementation.
- [at-peer-install.md](./at-peer-install.md) — `@peer` install design.
